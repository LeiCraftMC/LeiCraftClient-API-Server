import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuthHandler } from "../src/api/utils/authHandler";
import { AccountModel } from "../src/api/versions/v1/routes/account/model";
import { AuthModel } from "../src/api/versions/v1/routes/auth/model";
import { DB } from "../src/db";
import { AppConstants } from "../src/utils/constants";
import { makeAPIRequest } from "./helpers/api";
import { FakeDiscord, TEST_ADMIN_DISCORD_ID } from "./helpers/fakes";
import { loginWithDiscord } from "./helpers/flows";
import { nextDiscordID, seedUser, seedUserWithSession } from "./helpers/seed";

async function startLogin(redirectPath?: string) {
	return await makeAPIRequest("/v1/auth/discord/authorize", {
		method: "POST",
		body: redirectPath ? { redirect_path: redirectPath } : {},
		expectedBodySchema: AuthModel.DiscordAuthorize.Response,
	});
}

describe("Discord login", () => {
	test("authorize returns a Discord URL with the V1 scopes and a state", async () => {
		const data = await startLogin("/dashboard/wardrobe");

		const url = new URL(data.authorize_url);
		expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
		expect(url.searchParams.get("scope")).toBe("identify guilds.join");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:12560/auth/discord/callback");
		expect(url.searchParams.get("state")).toBe(data.state);

		// the state is stored hashed
		const row = await DB.instance().select().from(DB.Tables.oauthStates).all();
		expect(row.some((r) => r.state_hash === data.state)).toBe(false);
	});

	test("a callback with someone else's state fails without that browser's verifier", async () => {
		// the attacker starts a login and sends the victim the callback link (code + state)
		const attacker = await startLogin();
		const code = FakeDiscord.authorize({ id: nextDiscordID() });

		// the victim's browser has its own verifier (or none), not the attacker's
		const victim = await startLogin();
		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", body: { code, state: attacker.state, verifier: victim.verifier } },
			400,
		);
	});

	test("redirect_path must be an internal path", async () => {
		// browsers read these as //evil.example
		for (const redirectPath of ["/\\evil.example", "/\tevil.example", "/ /evil.example"]) {
			await makeAPIRequest(
				"/v1/auth/discord/authorize",
				{ method: "POST", body: { redirect_path: redirectPath } },
				400,
			);
		}
		await makeAPIRequest("/v1/auth/discord/authorize", {
			method: "POST",
			body: { redirect_path: "/shop/partner/some-page?tab=capes#top" },
		});

		await makeAPIRequest(
			"/v1/auth/discord/authorize",
			{ method: "POST", body: { redirect_path: "//evil.example" } },
			400,
		);
		await makeAPIRequest(
			"/v1/auth/discord/authorize",
			{ method: "POST", body: { redirect_path: "https://evil.example" } },
			400,
		);
	});

	test("callback creates the account, joins the guild and returns a session", async () => {
		const discordID = nextDiscordID();
		const { state, verifier } = await startLogin("/dashboard");
		const code = FakeDiscord.authorize({
			id: discordID,
			username: "leifan",
			global_name: "Lei Fan",
			avatar: "abc123",
		});

		const session = await makeAPIRequest("/v1/auth/discord/callback", {
			method: "POST",
			body: { code, state, verifier },
			expectedBodySchema: AuthModel.DiscordCallback.Response,
		});

		expect(session.token.startsWith(`${AppConstants.APP_KEYS_PREFIX}_sess_`)).toBe(true);
		expect(session.user_role).toBe("user");
		expect(session.redirect_path).toBe("/dashboard");
		expect(FakeDiscord.guildJoins).toContain(`100000000000000002:${discordID}`);

		const account = await makeAPIRequest("/v1/account", {
			authToken: session.token,
			expectedBodySchema: AccountModel.GetInfo.Response,
		});
		expect(account.discord_id).toBe(discordID);
		expect(account.discord_username).toBe("leifan");
		expect(account.display_name).toBe("Lei Fan");
		expect(account.avatar_url).toBe(`https://cdn.discordapp.com/avatars/${discordID}/abc123.png`);
	});

	test("a second login refreshes the Discord profile instead of creating a new user", async () => {
		const discordID = nextDiscordID();
		const first = await loginWithDiscord({ id: discordID, username: "old_name" });
		const second = await loginWithDiscord({ id: discordID, username: "new_name" });

		expect(second.user_id).toBe(first.user_id);

		const user = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(eq(DB.Tables.users.discord_id, discordID))
			.get();
		expect(user?.discord_username).toBe("new_name");
		expect(user?.display_name).toBe("new_name");
	});

	test("states are single-use", async () => {
		const { state, verifier } = await startLogin();
		const code = FakeDiscord.authorize({ id: nextDiscordID() });

		await makeAPIRequest("/v1/auth/discord/callback", {
			method: "POST",
			body: { code, state, verifier },
		});

		const secondCode = FakeDiscord.authorize({ id: nextDiscordID() });
		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", body: { code: secondCode, state, verifier } },
			400,
		);
	});

	test("unknown states and rejected codes fail", async () => {
		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", body: { code: "whatever", state: "not-a-real-state", verifier: "x" } },
			400,
		);

		const { state, verifier } = await startLogin();
		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", body: { code: "code-discord-never-issued", state, verifier } },
			400,
		);
	});

	test("Discord IDs from LCC_ADMIN_DISCORD_IDS become admins", async () => {
		const session = await loginWithDiscord({ id: TEST_ADMIN_DISCORD_ID, username: "bootstrap" });
		expect(session.user_role).toBe("admin");
	});

	test("banned users can't log in; expired bans don't block", async () => {
		const banned = await seedUser("user", {
			banned_at: Date.now(),
			banned_until: null,
			ban_reason: "cheating",
		});
		const { state, verifier } = await startLogin();
		const code = FakeDiscord.authorize({ id: banned.discord_id });
		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", body: { code, state, verifier } },
			403,
		);

		const expired = await seedUser("user", {
			banned_at: Date.now() - 10_000,
			banned_until: Date.now() - 1000,
			ban_reason: "old",
		});
		await loginWithDiscord({ id: expired.discord_id });
	});

	test("an authenticated caller can't run the callback", async () => {
		const { token } = await seedUserWithSession();
		const { state, verifier } = await startLogin();
		const code = FakeDiscord.authorize({ id: nextDiscordID() });

		await makeAPIRequest(
			"/v1/auth/discord/callback",
			{ method: "POST", authToken: token, body: { code, state, verifier } },
			403,
		);
	});

	test("a stale token does not block the login endpoints", async () => {
		await makeAPIRequest("/v1/auth/discord/authorize", {
			method: "POST",
			authToken: "lcc_sess_stale:token",
			body: {},
		});
	});
});

describe("Sessions", () => {
	test("GET /v1/auth/session and logout", async () => {
		const session = await loginWithDiscord({ id: nextDiscordID() });

		const info = await makeAPIRequest("/v1/auth/session", {
			authToken: session.token,
			expectedBodySchema: AuthModel.Session.Response,
		});
		expect(info.user_id).toBe(session.user_id);

		await makeAPIRequest("/v1/auth/logout", { method: "POST", authToken: session.token });
		expect(await AuthHandler.getAuthContext(session.token)).toBeNil();
		await makeAPIRequest("/v1/auth/session", { authToken: session.token }, 401);
	});

	test("invalid tokens and headers are rejected", async () => {
		await makeAPIRequest("/v1/account", { authToken: "invalid_token" }, 401);
		await makeAPIRequest(
			"/v1/account",
			{ additionalOptions: { headers: { Authorization: "Token invalid" } } },
			401,
		);
		await makeAPIRequest("/v1/account", {}, 401);
	});

	test("API keys work for the studio but not for account routes", async () => {
		const { token } = await seedUserWithSession();

		const key = await makeAPIRequest("/v1/account/apikeys", {
			method: "POST",
			authToken: token,
			body: { description: "partner bot", expires_at: "30d" },
		});
		expect(key.token.startsWith(`${AppConstants.APP_KEYS_PREFIX}_apikey_`)).toBe(true);

		await makeAPIRequest("/v1/studio/pages", { authToken: key.token }, 200);
		await makeAPIRequest("/v1/account", { authToken: key.token }, 401);
	});
});

describe("Account deletion", () => {
	test("DELETE /v1/account removes the user, their community page and Minecraft links", async () => {
		const session = await loginWithDiscord({ id: nextDiscordID() });

		const page = await makeAPIRequest("/v1/studio/pages", {
			method: "POST",
			authToken: session.token,
			body: { category: "community", slug: `del-${session.user_id}`, name: "Bye" },
		});

		const account = await DB.instance()
			.insert(DB.Tables.minecraftAccounts)
			.values({
				uuid: crypto.randomUUID(),
				name: "deleteme",
				user_id: session.user_id,
				linked_at: Date.now(),
				updated_at: Date.now(),
			})
			.returning()
			.get();

		await makeAPIRequest("/v1/account", { method: "DELETE", authToken: session.token });

		expect(
			await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.id, session.user_id))
				.get(),
		).toBeUndefined();
		expect(
			await DB.instance().select().from(DB.Tables.pages).where(eq(DB.Tables.pages.id, page.id)).get(),
		).toBeUndefined();

		const mc = await DB.instance()
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.id, account.id))
			.get();
		expect(mc?.user_id).toBeNull();
	});
});
