import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AccountInventoryModel } from "../src/api/versions/v1/routes/account/inventory/model";
import { StudioCodesModel } from "../src/api/versions/v1/routes/studio/pages/codes/model";
import { StudioProductsModel } from "../src/api/versions/v1/routes/studio/pages/products/model";
import { DB } from "../src/db";
import { makeAPIRequest } from "./helpers/api";
import {
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedSession,
	seedUser,
	seedUserWithSession,
} from "./helpers/seed";

type Session = Awaited<ReturnType<typeof seedUserWithSession>>;

async function redeem(token: string, code: string, expectedCode?: number) {
	return await makeAPIRequest(
		"/v1/account/inventory/redeem",
		{ method: "POST", authToken: token, body: { code } },
		expectedCode,
	);
}

describe("Redeem codes", () => {
	let partner: Session;
	let pageID: number;
	let exclusiveCape: Awaited<ReturnType<typeof seedProduct>>;
	let exclusiveHat: Awaited<ReturnType<typeof seedProduct>>;
	let freeCape: Awaited<ReturnType<typeof seedProduct>>;

	beforeAll(async () => {
		partner = await seedUserWithSession();
		const page = await seedPage("partner", partner.user.id);
		pageID = page.id;
		exclusiveCape = await seedProduct(pageID, "cape", { availability: "exclusive" });
		exclusiveHat = await seedProduct(pageID, "cosmetic", { availability: "exclusive" });
		freeCape = await seedProduct(pageID, "cape");
	});

	test("a custom code grants every product once per user", async () => {
		const [code] = await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, {
			method: "POST",
			authToken: partner.token,
			body: {
				code: "Summer2026",
				product_ids: [exclusiveCape.product.id, exclusiveHat.product.id],
				max_uses: null,
				note: "stream giveaway",
			},
			expectedBodySchema: StudioCodesModel.Create.Response,
		});
		expect(code?.code).toBe("SUMMER2026");
		expect(code?.products.map((product) => product.id).sort()).toEqual(
			[exclusiveCape.product.id, exclusiveHat.product.id].sort(),
		);

		const fan = await seedUserWithSession();
		const result = await redeem(fan.token, " summer2026 ");
		const parsed = AccountInventoryModel.Redeem.Response.parse(result);
		expect(parsed.granted_product_ids.sort()).toEqual(
			[exclusiveCape.product.id, exclusiveHat.product.id].sort(),
		);

		await redeem(fan.token, "SUMMER2026", 409);

		const inventory = await makeAPIRequest("/v1/account/inventory", {
			authToken: fan.token,
			expectedBodySchema: AccountInventoryModel.GetAll.Response,
		});
		expect(inventory.map((item) => item.product.id).sort()).toEqual(
			[exclusiveCape.product.id, exclusiveHat.product.id].sort(),
		);
		expect(inventory.every((item) => item.source === "code" && item.available)).toBe(true);

		// the owned exclusive can now be equipped
		const account = await seedMinecraftAccount(fan.user.id);
		await makeAPIRequest(`/v1/account/minecraft/${account.uuid}/loadout`, {
			method: "PUT",
			authToken: fan.token,
			body: {
				cape_product_id: exclusiveCape.product.id,
				cosmetics: [{ product_id: exclusiveHat.product.id }],
			},
		});
	});

	test("generated codes are single-use by default", async () => {
		const codes = await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, {
			method: "POST",
			authToken: partner.token,
			body: { product_ids: [exclusiveCape.product.id], count: 3 },
			expectedBodySchema: StudioCodesModel.Create.Response,
		});
		expect(codes.length).toBe(3);
		expect(new Set(codes.map((code) => code.code)).size).toBe(3);
		expect(codes[0]?.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		expect(codes[0]?.max_uses).toBe(1);

		const first = await seedUserWithSession();
		const second = await seedUserWithSession();
		await redeem(first.token, codes[0]?.code as string);
		await redeem(second.token, codes[0]?.code as string, 400);

		const detail = await makeAPIRequest(`/v1/studio/pages/${pageID}/codes/${codes[0]?.id}`, {
			authToken: partner.token,
			expectedBodySchema: StudioCodesModel.Code,
		});
		expect(detail.use_count).toBe(1);
		expect(detail.usable).toBe(false);

		const redemptions = await makeAPIRequest(
			`/v1/studio/pages/${pageID}/codes/${codes[0]?.id}/redemptions`,
			{ authToken: partner.token, expectedBodySchema: StudioCodesModel.Redemptions.Response },
		);
		expect(redemptions.map((r) => r.user.id)).toEqual([first.user.id]);
	});

	test("disabled and expired codes don't work", async () => {
		const [code] = await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, {
			method: "POST",
			authToken: partner.token,
			body: { product_ids: [exclusiveHat.product.id], max_uses: 100 },
		});

		await makeAPIRequest(`/v1/studio/pages/${pageID}/codes/${code.id}`, {
			method: "PUT",
			authToken: partner.token,
			body: { disabled: true },
		});
		const user = await seedUserWithSession();
		await redeem(user.token, code.code, 400);

		await makeAPIRequest(`/v1/studio/pages/${pageID}/codes/${code.id}`, {
			method: "PUT",
			authToken: partner.token,
			body: { disabled: false },
		});
		await DB.instance()
			.update(DB.Tables.redeemCodes)
			.set({ expires_at: Date.now() - 1 })
			.where(eq(DB.Tables.redeemCodes.id, code.id));
		await redeem(user.token, code.code, 400);

		await redeem(user.token, "DOES-NOT-EXIST", 400);
	});

	test("codes only grant exclusive products of the same page", async () => {
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/codes`,
			{ method: "POST", authToken: partner.token, body: { product_ids: [freeCape.product.id] } },
			400,
		);

		const otherPage = await seedPage("partner", null);
		const foreign = await seedProduct(otherPage.id, "cape", { availability: "exclusive" });
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/codes`,
			{ method: "POST", authToken: partner.token, body: { product_ids: [foreign.product.id] } },
			400,
		);

		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/codes`,
			{
				method: "POST",
				authToken: partner.token,
				body: { product_ids: [exclusiveCape.product.id], code: "SUMMER2026" },
			},
			409,
		);
	});

	test("only page members and admins manage codes", async () => {
		const stranger = await seedUserWithSession();
		await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, { authToken: stranger.token }, 404);

		const admin = await seedUserWithSession("admin");
		await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, { authToken: admin.token }, 200);
	});

	test("redeeming is rate limited", async () => {
		const user = await seedUserWithSession();
		for (let i = 0; i < 10; i++) {
			await redeem(user.token, `NOPE-${i}`, 400);
		}
		await redeem(user.token, "NOPE-LAST", 429);
	});
});

describe("Direct grants", () => {
	let partner: Session;
	let pageID: number;
	let exclusiveCape: Awaited<ReturnType<typeof seedProduct>>;

	beforeAll(async () => {
		partner = await seedUserWithSession();
		const page = await seedPage("official", partner.user.id);
		pageID = page.id;
		exclusiveCape = await seedProduct(pageID, "cape", { availability: "exclusive" });
	});

	test("grant by Discord id, by Minecraft name, and revoke", async () => {
		const byDiscord = await seedUser();
		const owner = await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners`,
			{
				method: "POST",
				authToken: partner.token,
				body: { discord_id: byDiscord.discord_id, note: "tournament winner" },
				expectedBodySchema: StudioProductsModel.Grant.Response,
			},
		);
		expect(owner.user.id).toBe(byDiscord.id);
		expect(owner.source).toBe("grant");
		expect(owner.granted_by?.id).toBe(partner.user.id);

		const player = await seedUser();
		const account = await seedMinecraftAccount(player.id, { name: "GrantMe" });
		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners`, {
			method: "POST",
			authToken: partner.token,
			body: { minecraft_name: "grantme" },
		});

		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners`,
			{ method: "POST", authToken: partner.token, body: { user_id: player.id } },
			409,
		);

		// equip, then revoke → unequipped
		const playerSession = await seedSession(player.id);
		await makeAPIRequest(`/v1/account/minecraft/${account.uuid}/loadout`, {
			method: "PUT",
			authToken: playerSession.token,
			body: { cape_product_id: exclusiveCape.product.id, cosmetics: [] },
		});

		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners/${player.id}`,
			{ method: "DELETE", authToken: partner.token },
		);

		const row = await DB.instance()
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.id, account.id))
			.get();
		expect(row?.cape_product_id).toBeNull();

		const owners = await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners`,
			{ authToken: partner.token, expectedBodySchema: StudioProductsModel.Owners.Response },
		);
		expect(owners.map((o) => o.user.id)).toEqual([byDiscord.id]);
	});

	test("grant targets must be unambiguous and existing", async () => {
		const path = `/v1/studio/pages/${pageID}/products/${exclusiveCape.product.id}/owners`;
		await makeAPIRequest(path, { method: "POST", authToken: partner.token, body: {} }, 400);
		await makeAPIRequest(
			path,
			{
				method: "POST",
				authToken: partner.token,
				body: { user_id: 1, discord_id: "123456789012345678" },
			},
			400,
		);
		await makeAPIRequest(
			path,
			{ method: "POST", authToken: partner.token, body: { minecraft_name: "NobodyHasThis" } },
			404,
		);
	});

	test("free products can't be granted", async () => {
		const free = await seedProduct(pageID, "cape");
		const user = await seedUser();
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${free.product.id}/owners`,
			{ method: "POST", authToken: partner.token, body: { user_id: user.id } },
			400,
		);
	});

	test("grants are written to the audit log", async () => {
		const admin = await seedUserWithSession("admin");
		const log = await makeAPIRequest(
			`/v1/admin/audit-logs?action=product.grant&target_id=${exclusiveCape.product.id}`,
			{ authToken: admin.token },
		);
		expect(log.length).toBeGreaterThanOrEqual(2);
		expect(log[0].actor.id).toBe(partner.user.id);
	});
});
