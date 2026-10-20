import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { API } from "../src/api";
import { AccountMinecraftModel } from "../src/api/versions/v1/routes/account/minecraft/model";
import { ClientModel } from "../src/api/versions/v1/routes/client/model";
import { PlayersModel } from "../src/api/versions/v1/routes/players/model";
import { DB } from "../src/db";
import { AppConstants } from "../src/utils/constants";
import { makeAPIRequest } from "./helpers/api";
import { FakeMojang } from "./helpers/fakes";
import { loginWithMinecraft } from "./helpers/flows";
import {
	randomMinecraftName,
	randomMinecraftUUID,
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedUser,
	seedUserWithSession,
} from "./helpers/seed";

describe("Mod handshake (Mojang session server)", () => {
	test("verify creates the Minecraft account with skin data and returns a client token", async () => {
		const session = await loginWithMinecraft({ name: "SlimSteve", skinModel: "slim" });

		expect(session.token.startsWith(`${AppConstants.APP_KEYS_PREFIX}_client_`)).toBe(true);
		expect(session.account.uuid).toBe(session.uuid);
		expect(session.account.name).toBe("SlimSteve");
		expect(session.account.skin_model).toBe("slim");
		expect(session.account.skin_url?.startsWith("https://textures.minecraft.net/")).toBe(true);
		expect(session.account.uses_client).toBe(true);
		expect(session.user).toBeNull();

		const info = await makeAPIRequest("/v1/client/session", {
			authToken: session.token,
			expectedBodySchema: ClientModel.Session.Response,
		});
		expect(info.account.uuid).toBe(session.uuid);
	});

	test("a second login updates the name of the same account", async () => {
		const uuid = randomMinecraftUUID();
		await loginWithMinecraft({ uuid, name: "OldName" });
		const second = await loginWithMinecraft({ uuid, name: "NewName" });

		expect(second.account.name).toBe("NewName");
		const rows = await DB.instance()
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.uuid, uuid))
			.all();
		expect(rows.length).toBe(1);
	});

	test("verify fails when Mojang does not confirm the join", async () => {
		const challenge = await makeAPIRequest("/v1/client/auth/challenge", { method: "POST" });

		// the game never called joinServer for this server id
		await makeAPIRequest(
			"/v1/client/auth/verify",
			{ method: "POST", body: { challenge_id: challenge.challenge_id, username: "Notch" } },
			401,
		);
	});

	test("verify fails for another username than the one that joined", async () => {
		const challenge = await makeAPIRequest("/v1/client/auth/challenge", { method: "POST" });
		FakeMojang.joinServer(challenge.server_id, { uuid: randomMinecraftUUID(), name: "RealOwner" });

		await makeAPIRequest(
			"/v1/client/auth/verify",
			{ method: "POST", body: { challenge_id: challenge.challenge_id, username: "Impostor" } },
			401,
		);
	});

	test("challenges are single-use", async () => {
		const challenge = await makeAPIRequest("/v1/client/auth/challenge", { method: "POST" });
		const name = randomMinecraftName();
		FakeMojang.joinServer(challenge.server_id, { uuid: randomMinecraftUUID(), name });

		const body = { challenge_id: challenge.challenge_id, username: name };
		await makeAPIRequest("/v1/client/auth/verify", { method: "POST", body });
		await makeAPIRequest("/v1/client/auth/verify", { method: "POST", body }, 400);
	});

	test("client endpoints need a client session", async () => {
		const { token } = await seedUserWithSession();
		await makeAPIRequest("/v1/client/session", { authToken: token }, 401);
		await makeAPIRequest("/v1/client/session", {}, 401);
	});

	test("logout ends the client session", async () => {
		const session = await loginWithMinecraft();
		await makeAPIRequest("/v1/client/logout", { method: "POST", authToken: session.token });
		await makeAPIRequest("/v1/client/session", { authToken: session.token }, 401);
	});
});

describe("Linking a Minecraft account through the mod's link", () => {
	test("full flow: link → preview → confirm → status", async () => {
		const mod = await loginWithMinecraft({ name: "LinkMe" });
		const web = await seedUserWithSession();

		const link = await makeAPIRequest("/v1/client/link", {
			method: "POST",
			authToken: mod.token,
			expectedBodySchema: ClientModel.CreateLink.Response,
		});
		expect(link.url).toBe(
			`http://localhost:12332/link/minecraft?code=${encodeURIComponent(link.code)}`,
		);

		const pending = await makeAPIRequest("/v1/client/link", {
			authToken: mod.token,
			expectedBodySchema: ClientModel.LinkStatus.Response,
		});
		expect(pending.linked).toBe(false);
		expect(pending.pending_code_expires_at).toBe(link.expires_at);

		const preview = await makeAPIRequest(`/v1/account/minecraft/link/${link.code}`, {
			authToken: web.token,
			expectedBodySchema: AccountMinecraftModel.LinkPreview.Response,
		});
		expect(preview.account.name).toBe("LinkMe");
		expect(preview.linked_to_you).toBe(false);

		await makeAPIRequest("/v1/account/minecraft/link", {
			method: "POST",
			authToken: web.token,
			body: { code: link.code },
		});

		const status = await makeAPIRequest("/v1/client/link", {
			authToken: mod.token,
			expectedBodySchema: ClientModel.LinkStatus.Response,
		});
		expect(status.linked).toBe(true);
		expect(status.user?.id).toBe(web.user.id);

		const accounts = await makeAPIRequest("/v1/account/minecraft", {
			authToken: web.token,
			expectedBodySchema: AccountMinecraftModel.GetAll.Response,
		});
		expect(accounts.map((account) => account.uuid)).toEqual([mod.uuid]);

		// the code was consumed
		await makeAPIRequest(
			"/v1/account/minecraft/link",
			{ method: "POST", authToken: web.token, body: { code: link.code } },
			400,
		);
		// a linked account can't create new links
		await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token }, 409);
	});

	test("a new link code replaces the previous one", async () => {
		const mod = await loginWithMinecraft();
		const web = await seedUserWithSession();

		const first = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token });
		const second = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token });

		await makeAPIRequest(
			"/v1/account/minecraft/link",
			{ method: "POST", authToken: web.token, body: { code: first.code } },
			400,
		);
		await makeAPIRequest("/v1/account/minecraft/link", {
			method: "POST",
			authToken: web.token,
			body: { code: second.code },
		});
	});

	test("expired codes are rejected", async () => {
		const mod = await loginWithMinecraft();
		const web = await seedUserWithSession();
		const link = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token });

		await DB.instance()
			.update(DB.Tables.minecraftLinkCodes)
			.set({ expires_at: Date.now() - 1 });

		await makeAPIRequest(`/v1/account/minecraft/link/${link.code}`, { authToken: web.token }, 404);
		await makeAPIRequest(
			"/v1/account/minecraft/link",
			{ method: "POST", authToken: web.token, body: { code: link.code } },
			400,
		);
	});

	test("a user can link at most 5 accounts", async () => {
		const web = await seedUserWithSession();
		for (let i = 0; i < 5; i++) {
			await seedMinecraftAccount(web.user.id);
		}

		const mod = await loginWithMinecraft();
		const link = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token });
		await makeAPIRequest(
			"/v1/account/minecraft/link",
			{ method: "POST", authToken: web.token, body: { code: link.code } },
			409,
		);
	});

	test("unlinking from the website and from the mod", async () => {
		const web = await seedUserWithSession();

		const fromWebsite = await loginWithMinecraft();
		let link = await makeAPIRequest("/v1/client/link", {
			method: "POST",
			authToken: fromWebsite.token,
		});
		await makeAPIRequest("/v1/account/minecraft/link", {
			method: "POST",
			authToken: web.token,
			body: { code: link.code },
		});
		await makeAPIRequest(`/v1/account/minecraft/${fromWebsite.uuid}`, {
			method: "DELETE",
			authToken: web.token,
		});

		const fromMod = await loginWithMinecraft();
		link = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: fromMod.token });
		await makeAPIRequest("/v1/account/minecraft/link", {
			method: "POST",
			authToken: web.token,
			body: { code: link.code },
		});
		await makeAPIRequest("/v1/client/link", { method: "DELETE", authToken: fromMod.token });

		const accounts = await makeAPIRequest("/v1/account/minecraft", { authToken: web.token });
		expect(accounts).toEqual([]);

		// someone else's account can't be unlinked through the website
		const other = await seedUser();
		const othersAccount = await seedMinecraftAccount(other.id);
		await makeAPIRequest(
			`/v1/account/minecraft/${othersAccount.uuid}`,
			{ method: "DELETE", authToken: web.token },
			404,
		);
	});
});

describe("Loadouts and player profiles", () => {
	let web: Awaited<ReturnType<typeof seedUserWithSession>>;
	let account: Awaited<ReturnType<typeof seedMinecraftAccount>>;
	let cape: Awaited<ReturnType<typeof seedProduct>>;
	let hat: Awaited<ReturnType<typeof seedProduct>>;
	let exclusiveCape: Awaited<ReturnType<typeof seedProduct>>;

	beforeAll(async () => {
		web = await seedUserWithSession();
		account = await seedMinecraftAccount(web.user.id, { name: "Wearer" });

		const page = await seedPage("official", null);
		cape = await seedProduct(page.id, "cape");
		hat = await seedProduct(page.id, "cosmetic");
		exclusiveCape = await seedProduct(page.id, "cape", { availability: "exclusive" });
	});

	test("equip a free cape and a cosmetic; the profile is render-ready", async () => {
		const loadout = await makeAPIRequest(`/v1/account/minecraft/${account.uuid}/loadout`, {
			method: "PUT",
			authToken: web.token,
			body: {
				cape_product_id: cape.product.id,
				cosmetics: [{ product_id: hat.product.id }],
			},
			expectedBodySchema: AccountMinecraftModel.Loadout.Response,
		});
		expect(loadout.cape?.id).toBe(cape.product.id);
		expect(loadout.cosmetics[0]?.product.id).toBe(hat.product.id);
		expect(loadout.cosmetics[0]?.variant_id).toBeNull();

		const profile = await makeAPIRequest(`/v1/players/${account.uuid}`, {
			expectedBodySchema: PlayersModel.GetByUUID.Response,
		});
		expect(profile.cape?.product_id).toBe(cape.product.id);
		expect(profile.cape?.texture.url).toMatch(
			/^http:\/\/localhost:12331\/assets\/[0-9a-f]{64}\.png$/,
		);
		expect(profile.cosmetics[0]?.variants[0]?.model.url).toMatch(/\.json$/);
		expect(profile.cosmetics[0]?.variants[0]?.skin_model).toBe("any");

		// the asset URLs serve the files, immutable and embeddable from anywhere
		const res = await API.getApp().request(new URL(profile.cape?.texture.url as string).pathname, {
			headers: { Origin: "https://some-other-site.example" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	test("lookup by UUID (dashed or not) and by name; unknown players are omitted", async () => {
		const profiles = await makeAPIRequest("/v1/players/lookup", {
			method: "POST",
			body: {
				uuids: [account.uuid.replaceAll("-", ""), randomMinecraftUUID()],
				names: ["wearer"],
			},
			expectedBodySchema: PlayersModel.Lookup.Response,
		});
		expect(profiles.length).toBe(1);
		expect(profiles[0]?.uuid).toBe(account.uuid);

		const byName = await makeAPIRequest("/v1/players/by-name/Wearer", {
			expectedBodySchema: PlayersModel.GetByName.Response,
		});
		expect(byName.uuid).toBe(account.uuid);

		await makeAPIRequest(`/v1/players/${randomMinecraftUUID()}`, {}, 404);
	});

	test("pinning a variant of another product fails", async () => {
		const otherHat = await seedProduct(cape.product.page_id, "cosmetic");

		await makeAPIRequest(
			`/v1/account/minecraft/${account.uuid}/loadout`,
			{
				method: "PUT",
				authToken: web.token,
				body: {
					cape_product_id: null,
					cosmetics: [{ product_id: hat.product.id, variant_id: otherHat.variant?.id }],
				},
			},
			400,
		);
	});

	test("type mismatches, drafts and duplicates are rejected", async () => {
		const draft = await seedProduct(cape.product.page_id, "cape", { status: "draft" });

		for (const body of [
			{ cape_product_id: hat.product.id, cosmetics: [] },
			{ cape_product_id: draft.product.id, cosmetics: [] },
			{ cape_product_id: null, cosmetics: [{ product_id: cape.product.id }] },
			{
				cape_product_id: null,
				cosmetics: [{ product_id: hat.product.id }, { product_id: hat.product.id }],
			},
		]) {
			await makeAPIRequest(
				`/v1/account/minecraft/${account.uuid}/loadout`,
				{ method: "PUT", authToken: web.token, body },
				400,
			);
		}
	});

	test("exclusive products need ownership", async () => {
		await makeAPIRequest(
			`/v1/account/minecraft/${account.uuid}/loadout`,
			{
				method: "PUT",
				authToken: web.token,
				body: { cape_product_id: exclusiveCape.product.id, cosmetics: [] },
			},
			403,
		);
	});

	test("the mod can read and set its own loadout once linked", async () => {
		const mod = await loginWithMinecraft();

		await makeAPIRequest(
			"/v1/client/loadout",
			{
				method: "PUT",
				authToken: mod.token,
				body: { cape_product_id: cape.product.id, cosmetics: [] },
			},
			400,
		);

		const link = await makeAPIRequest("/v1/client/link", { method: "POST", authToken: mod.token });
		await makeAPIRequest("/v1/account/minecraft/link", {
			method: "POST",
			authToken: web.token,
			body: { code: link.code },
		});

		await makeAPIRequest("/v1/client/loadout", {
			method: "PUT",
			authToken: mod.token,
			body: { cape_product_id: cape.product.id, cosmetics: [] },
		});
		const loadout = await makeAPIRequest("/v1/client/loadout", {
			authToken: mod.token,
			expectedBodySchema: AccountMinecraftModel.Loadout.Response,
		});
		expect(loadout.cape?.id).toBe(cape.product.id);
	});

	test("disabled products and banned users disappear from profiles", async () => {
		const owner = await seedUser();
		const wearer = await seedMinecraftAccount(owner.id, { cape_product_id: cape.product.id });

		let [profile] = await makeAPIRequest("/v1/players/lookup", {
			method: "POST",
			body: { uuids: [wearer.uuid] },
		});
		expect(profile.cape?.product_id).toBe(cape.product.id);

		await DB.instance()
			.update(DB.Tables.users)
			.set({ banned_at: Date.now() })
			.where(eq(DB.Tables.users.id, owner.id));

		[profile] = await makeAPIRequest("/v1/players/lookup", {
			method: "POST",
			body: { uuids: [wearer.uuid] },
		});
		expect(profile.cape).toBeNull();
		expect(profile.cosmetics).toEqual([]);
	});

	test("unlinking clears the loadout", async () => {
		const owner = await seedUserWithSession();
		const wearer = await seedMinecraftAccount(owner.user.id, { cape_product_id: cape.product.id });
		expect(wearer.cape_product_id).toBe(cape.product.id);

		await makeAPIRequest(`/v1/account/minecraft/${wearer.uuid}`, {
			method: "DELETE",
			authToken: owner.token,
		});

		const row = await DB.instance()
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.id, wearer.id))
			.get();
		expect(row?.cape_product_id).toBeNull();
		expect(row?.user_id).toBeNull();
	});
});
