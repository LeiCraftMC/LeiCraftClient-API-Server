import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { API } from "../src/api";
import { LoadoutHandler } from "../src/api/utils/loadouts";
import { SkinProxy } from "../src/api/utils/skins";
import { AccountMinecraftModel } from "../src/api/versions/v1/routes/account/minecraft/model";
import { AccountModel } from "../src/api/versions/v1/routes/account/model";
import { ClientModel } from "../src/api/versions/v1/routes/client/model";
import { PlayersModel } from "../src/api/versions/v1/routes/players/model";
import { DB } from "../src/db";
import { makeAPIRequest } from "./helpers/api";
import { loginWithMinecraft } from "./helpers/flows";
import { createPNG } from "./helpers/png";
import {
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedUser,
	seedUserWithSession,
} from "./helpers/seed";

// Many authenticated requests each (argon2 checks): beyond Bun's 5 s default on a busy machine.
describe("Wardrobe", () => {
	test("holds owned exclusives and saved free products, not the whole catalog", async () => {
		const page = await seedPage("partner", null);
		const { product: free } = await seedProduct(page.id, "cape");
		const { product: unlisted } = await seedProduct(page.id, "cape", { listed: false });
		const { product: notSaved } = await seedProduct(page.id, "cape");
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

		const list = async (query = "limit=100") =>
			await makeAPIRequest(`/v1/account/wardrobe?${query}`, {
				authToken: token,
				expectedBodySchema: AccountModel.Wardrobe.Response,
			});
		const save = async (productID: number, expectedCode?: number) =>
			await makeAPIRequest(
				`/v1/account/wardrobe/${productID}`,
				{ method: "PUT", authToken: token },
				expectedCode,
			);
		const remove = async (productID: number, expectedCode?: number) =>
			await makeAPIRequest(
				`/v1/account/wardrobe/${productID}`,
				{ method: "DELETE", authToken: token },
				expectedCode,
			);

		// A fresh wardrobe only holds the owned exclusive.
		const initial = await list();
		expect(initial.map((item) => item.product.id)).toEqual([ownedExclusive.id]);
		expect(initial[0]?.owned).toBe(true);
		expect(initial[0]?.removable).toBe(false);

		expect(await save(free.id)).toEqual({ in_wardrobe: true, owned: false, removable: true });
		await save(free.id); // idempotent
		await save(unlisted.id); // reachable by id, so it can be saved
		await save(otherExclusive.id, 403);
		await save(draft.id, 404);
		await save(999999, 404);
		expect(await save(ownedExclusive.id)).toEqual({
			in_wardrobe: true,
			owned: true,
			removable: false,
		});

		const items = await list();
		// owned exclusives first, then the most recently saved
		expect(items.map((item) => item.product.id)).toEqual([ownedExclusive.id, unlisted.id, free.id]);
		expect(items[1]?.removable).toBe(true);

		const ownedOnly = await list("owned_only=true");
		expect(ownedOnly.map((item) => item.product.id)).toEqual([ownedExclusive.id]);

		const capes = await list("type=cape&limit=100");
		expect(capes.map((item) => item.product.id)).toEqual([unlisted.id, free.id]);

		const status = await makeAPIRequest(`/v1/account/wardrobe/${notSaved.id}`, {
			authToken: token,
			expectedBodySchema: AccountModel.WardrobeItem.Response,
		});
		expect(status.in_wardrobe).toBe(false);

		await remove(ownedExclusive.id, 409);
		await remove(notSaved.id, 404);
		await remove(free.id);
		expect((await list()).map((item) => item.product.id)).toEqual([ownedExclusive.id, unlisted.id]);

		// Taken down: gone from the listing.
		await DB.instance()
			.update(DB.Tables.products)
			.set({ status: "disabled" })
			.where(eq(DB.Tables.products.id, unlisted.id));
		expect((await list()).map((item) => item.product.id)).toEqual([ownedExclusive.id]);
	}, 30_000);

	test("equipping saves to the wardrobe and removing takes it off every account", async () => {
		const page = await seedPage("partner", null);
		const { product: cape } = await seedProduct(page.id, "cape");
		const { product: cosmetic } = await seedProduct(page.id, "cosmetic");

		const { user, token } = await seedUserWithSession();
		const first = await seedMinecraftAccount(user.id);
		const second = await seedMinecraftAccount(user.id);

		await makeAPIRequest(`/v1/account/minecraft/${first.uuid}/loadout`, {
			method: "PUT",
			authToken: token,
			body: { cape_product_id: cape.id, cosmetics: [{ product_id: cosmetic.id }] },
		});
		await makeAPIRequest(`/v1/account/minecraft/${second.uuid}/loadout`, {
			method: "PUT",
			authToken: token,
			body: { cape_product_id: cape.id, cosmetics: [] },
		});

		const items = await makeAPIRequest("/v1/account/wardrobe", {
			authToken: token,
			expectedBodySchema: AccountModel.Wardrobe.Response,
		});
		expect(items.map((item) => item.product.id).sort()).toEqual([cape.id, cosmetic.id].sort());

		await makeAPIRequest(`/v1/account/wardrobe/${cape.id}`, { method: "DELETE", authToken: token });

		const loadouts = await Promise.all(
			[first, second].map(
				async (account) =>
					await makeAPIRequest(`/v1/account/minecraft/${account.uuid}/loadout`, {
						authToken: token,
						expectedBodySchema: AccountMinecraftModel.Loadout.Response,
					}),
			),
		);
		expect(loadouts.map((loadout) => loadout.cape)).toEqual([null, null]);
		expect(loadouts[0]?.cosmetics.map((entry) => entry.product.id)).toEqual([cosmetic.id]);
	}, 30_000);

	test("the mod's wardrobe needs a linked account and lists the same items", async () => {
		const session = await loginWithMinecraft();
		await makeAPIRequest("/v1/client/wardrobe", { authToken: session.token }, 400);

		const { user, token } = await seedUserWithSession();
		await DB.instance()
			.update(DB.Tables.minecraftAccounts)
			.set({ user_id: user.id, linked_at: Date.now() })
			.where(eq(DB.Tables.minecraftAccounts.uuid, session.uuid));

		const page = await seedPage("partner", null);
		const { product: saved } = await seedProduct(page.id, "cosmetic");
		await seedProduct(page.id, "cosmetic");
		await makeAPIRequest(`/v1/account/wardrobe/${saved.id}`, { method: "PUT", authToken: token });

		const items = await makeAPIRequest("/v1/client/wardrobe?type=cosmetic", {
			authToken: session.token,
			expectedBodySchema: ClientModel.Wardrobe.Response,
		});
		expect(items.map((item) => item.product.id)).toEqual([saved.id]);
	}, 30_000);
});

describe("Showcase", () => {
	test("shows players who wear something visible, never banned users", async () => {
		const page = await seedPage("partner", null);
		const { product: cape } = await seedProduct(page.id, "cape");
		const { product: draftCape } = await seedProduct(page.id, "cape", { status: "draft" });

		const wearer = await seedUser();
		const wearing = await seedMinecraftAccount(wearer.id, { cape_product_id: cape.id });

		const banned = await seedUser("user", { banned_at: Date.now() });
		const bannedAccount = await seedMinecraftAccount(banned.id, { cape_product_id: cape.id });

		const hidden = await seedUser();
		const hiddenAccount = await seedMinecraftAccount(hidden.id, { cape_product_id: draftCape.id });

		const unlinked = await seedMinecraftAccount(null, { cape_product_id: cape.id });

		LoadoutHandler.clearShowcasePool();
		const profiles = await makeAPIRequest("/v1/players/showcase?limit=12", {
			expectedBodySchema: PlayersModel.Showcase.Response,
		});
		const uuids = profiles.map((profile) => profile.uuid);

		expect(uuids).toContain(wearing.uuid);
		expect(uuids).not.toContain(bannedAccount.uuid);
		expect(uuids).not.toContain(hiddenAccount.uuid);
		expect(uuids).not.toContain(unlinked.uuid);
		expect(profiles.every((profile) => profile.cape !== null || profile.cosmetics.length > 0)).toBe(
			true,
		);

		await makeAPIRequest("/v1/players/showcase?limit=50", {}, 400);
	}, 30_000);
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
