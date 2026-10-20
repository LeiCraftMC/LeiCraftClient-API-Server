import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { API } from "../src/api";
import { SkinProxy } from "../src/api/utils/skins";
import { AccountModel } from "../src/api/versions/v1/routes/account/model";
import { ClientModel } from "../src/api/versions/v1/routes/client/model";
import { DB } from "../src/db";
import { makeAPIRequest } from "./helpers/api";
import { loginWithMinecraft } from "./helpers/flows";
import { createPNG } from "./helpers/png";
import { seedMinecraftAccount, seedPage, seedProduct, seedUserWithSession } from "./helpers/seed";

describe("Wardrobe", () => {
	test("lists free listed products and owned exclusives, owned first", async () => {
		const page = await seedPage("partner", null);
		const { product: free } = await seedProduct(page.id, "cape");
		const { product: unlisted } = await seedProduct(page.id, "cape", { listed: false });
		const { product: ownedExclusive } = await seedProduct(page.id, "cosmetic", {
			availability: "exclusive",
			listed: false,
		});
		const { product: otherExclusive } = await seedProduct(page.id, "cape", {
			availability: "exclusive",
		});
		const { product: draft } = await seedProduct(page.id, "cape", { status: "draft" });

		const { user, token } = await seedUserWithSession();
		await DB.instance()
			.insert(DB.Tables.userItems)
			.values({ user_id: user.id, product_id: ownedExclusive.id, source: "grant" });

		const items = await makeAPIRequest("/v1/account/wardrobe?limit=100", {
			authToken: token,
			expectedBodySchema: AccountModel.Wardrobe.Response,
		});
		const ids = items.map((item) => item.product.id);

		expect(items[0]?.product.id).toBe(ownedExclusive.id);
		expect(items[0]?.owned).toBe(true);
		expect(ids).toContain(free.id);
		expect(ids).not.toContain(unlisted.id);
		expect(ids).not.toContain(otherExclusive.id);
		expect(ids).not.toContain(draft.id);

		const ownedOnly = await makeAPIRequest("/v1/account/wardrobe?owned_only=true", {
			authToken: token,
			expectedBodySchema: AccountModel.Wardrobe.Response,
		});
		expect(ownedOnly.map((item) => item.product.id)).toEqual([ownedExclusive.id]);

		const capes = await makeAPIRequest("/v1/account/wardrobe?type=cape&limit=100", {
			authToken: token,
			expectedBodySchema: AccountModel.Wardrobe.Response,
		});
		expect(capes.every((item) => item.product.type === "cape")).toBe(true);
	});

	test("the mod's wardrobe needs a linked account", async () => {
		const session = await loginWithMinecraft();
		await makeAPIRequest("/v1/client/wardrobe", { authToken: session.token }, 400);

		const { user } = await seedUserWithSession();
		await DB.instance()
			.update(DB.Tables.minecraftAccounts)
			.set({ user_id: user.id, linked_at: Date.now() })
			.where(eq(DB.Tables.minecraftAccounts.uuid, session.uuid));

		await makeAPIRequest("/v1/client/wardrobe?type=cosmetic", {
			authToken: session.token,
			expectedBodySchema: ClientModel.Wardrobe.Response,
		});
	});
});

describe("Skin proxy", () => {
	const skinURL = "http://textures.minecraft.net/texture/0123456789abcdef";
	const requested: string[] = [];

	afterAll(() => {
		SkinProxy.setFetcher(null);
	});

	test("serves a known account's skin with CORS and caches it", async () => {
		SkinProxy.setFetcher(async (input) => {
			requested.push(input);
			return new Response(createPNG(64, 64, [9, 9, 9, 255]), {
				headers: { "Content-Type": "image/png" },
			});
		});

		const account = await seedMinecraftAccount(null);
		await DB.instance()
			.update(DB.Tables.minecraftAccounts)
			.set({ skin_url: skinURL })
			.where(eq(DB.Tables.minecraftAccounts.id, account.id));

		for (let i = 0; i < 2; i++) {
			const res = await API.getApp().request(`/skins/${account.uuid}.png`, {
				headers: { Origin: "https://client.leicraftmc.de" },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		}

		// fetched once, over https
		expect(requested).toEqual(["https://textures.minecraft.net/texture/0123456789abcdef"]);
	});

	test("unknown accounts, foreign hosts and non-PNG answers are 404", async () => {
		SkinProxy.setFetcher(async () => new Response("<html>not a skin</html>"));

		const unknown = await API.getApp().request(`/skins/${crypto.randomUUID()}.png`);
		expect(unknown.status).toBe(404);

		const foreign = await seedMinecraftAccount(null);
		await DB.instance()
			.update(DB.Tables.minecraftAccounts)
			.set({ skin_url: "https://evil.example/texture/abc" })
			.where(eq(DB.Tables.minecraftAccounts.id, foreign.id));
		expect((await API.getApp().request(`/skins/${foreign.uuid}.png`)).status).toBe(404);

		const html = await seedMinecraftAccount(null);
		await DB.instance()
			.update(DB.Tables.minecraftAccounts)
			.set({ skin_url: "http://textures.minecraft.net/texture/fedcba" })
			.where(eq(DB.Tables.minecraftAccounts.id, html.id));
		expect((await API.getApp().request(`/skins/${html.uuid}.png`)).status).toBe(404);

		expect((await API.getApp().request("/skins/not-a-uuid.png")).status).toBe(404);
	});
});
