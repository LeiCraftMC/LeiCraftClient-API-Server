import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { ConfigHandler } from "../../../../../utils/config";
import { LCrypt } from "../../../../../utils/crypto/lcrypt";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler, SessionHandler } from "../../../../utils/authHandler";
import { DiscordOAuth } from "../../../../utils/discord";
import { RateLimiter, RequestUtils } from "../../../../utils/rateLimiter";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { UserHandler } from "../../../../utils/users";
import { DOCS_TAGS } from "../../docs";
import { AuthModel } from "./model";

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;

// Each authorize call stores a state row; keep anonymous callers from flooding the table.
const authorizeLimiter = new RateLimiter(30, 60 * 1000);

export function hashOAuthState(state: string) {
	return LCrypt.sha256(state).toHex();
}

export const router = new Hono().basePath("/auth");

router.post(
	"/discord/authorize",

	APIRouteSpec.unauthenticated({
		summary: "Start Discord login",
		description:
			"Create a single-use OAuth2 `state`, a `verifier` the browser keeps, and the Discord authorize URL (scopes `identify guilds.join`). Send the browser to `authorize_url`; Discord redirects back to the website's callback page (`LCC_DISCORD_REDIRECT_URI`, default `<APP_URL>/auth/discord/callback`) with `code` and `state`, which the website passes to `POST /auth/discord/callback`.",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Discord authorize URL created", AuthModel.DiscordAuthorize.Response),
			APIResponseSpec.tooManyRequests("Too many login attempts. Try again later."),
		),
	}),

	zValidator("json", AuthModel.DiscordAuthorize.Body),

	async (c) => {
		const limit = authorizeLimiter.hit(RequestUtils.getClientIP(c));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many login attempts. Try again later.");
		}

		const { redirect_path } = c.req.valid("json");

		const state = LCrypt.randomBytes(32).toString("hex");
		const verifier = LCrypt.randomBytes(32).toString("hex");
		const expiresAt = Date.now() + OAUTH_STATE_LIFETIME_MS;

		await DB.instance()
			.insert(DB.Tables.oauthStates)
			.values({
				state_hash: hashOAuthState(state),
				verifier_hash: hashOAuthState(verifier),
				redirect_path: redirect_path ?? null,
				expires_at: expiresAt,
			});

		return APIResponse.success(c, "Discord authorize URL created", {
			authorize_url: DiscordOAuth.buildAuthorizeURL(state),
			state,
			verifier,
			expires_at: expiresAt,
		} satisfies AuthModel.DiscordAuthorize.Response);
	},
);

router.post(
	"/discord/callback",

	APIRouteSpec.unauthenticated({
		summary: "Finish Discord login",
		description:
			"Exchange the Discord authorization `code` (with the matching single-use `state` and the browser's `verifier`) for a LeiCraft session. Creates the account on the first login, refreshes the Discord profile on every login and adds the user to the LeiCraftMC Discord server.",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Login successful", AuthModel.DiscordCallback.Response),
			APIResponseSpec.badRequest(
				"Invalid or expired login state / Discord rejected the authorization code / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("You are already authenticated / Your account is banned"),
			APIResponseSpec.serverError("Failed to complete the Discord login"),
		),
	}),

	zValidator("json", AuthModel.DiscordCallback.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);
		if (authContext.type !== "unauthenticated") {
			return APIResponse.forbidden(c, "You are already authenticated");
		}

		const { code, state, verifier } = c.req.valid("json");

		const storedState = await DB.instance()
			.delete(DB.Tables.oauthStates)
			.where(eq(DB.Tables.oauthStates.state_hash, hashOAuthState(state)))
			.returning()
			.get();

		// The verifier never travels in a URL: a callback link from someone else's login fails here.
		if (
			!storedState ||
			storedState.expires_at < Date.now() ||
			storedState.verifier_hash !== hashOAuthState(verifier)
		) {
			return APIResponse.badRequest(c, "Invalid or expired login state");
		}

		try {
			const accessToken = await DiscordOAuth.exchangeCode(code);
			if (!accessToken) {
				return APIResponse.badRequest(c, "Discord rejected the authorization code");
			}

			const discordUser = await DiscordOAuth.fetchUser(accessToken);
			if (!discordUser) {
				return APIResponse.serverError(c, "Failed to load the Discord account");
			}

			const isBootstrapAdmin = (ConfigHandler.getConfig()?.ADMIN_DISCORD_IDS ?? []).includes(
				discordUser.id,
			);

			const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
				const profile = {
					discord_username: discordUser.username,
					display_name: discordUser.global_name ?? discordUser.username,
					discord_avatar_hash: discordUser.avatar,
					last_login_at: Date.now(),
				};

				let user = await tx
					.insert(DB.Tables.users)
					.values({
						discord_id: discordUser.id,
						...profile,
						role: isBootstrapAdmin ? "admin" : "user",
					})
					.onConflictDoUpdate({ target: DB.Tables.users.discord_id, set: profile })
					.returning()
					.get();

				if (UserHandler.isBanned(user)) {
					return { banned: true as const, user };
				}

				if (isBootstrapAdmin && user.role !== "admin") {
					user = await tx
						.update(DB.Tables.users)
						.set({ role: "admin" })
						.where(eq(DB.Tables.users.id, user.id))
						.returning()
						.get();
					await AuthHandler.changeUserRoleInAuthContexts(user.id, "admin", tx);
				}

				return { banned: false as const, session: await SessionHandler.createSession(user.id, tx) };
			});

			if (result.banned) {
				const until = result.user.banned_until
					? ` until ${new Date(result.user.banned_until).toISOString()}`
					: "";
				const reason = result.user.ban_reason ? `: ${result.user.ban_reason}` : "";
				return APIResponse.forbidden(c, `Your account is banned${until}${reason}`);
			}

			await DiscordOAuth.addToGuild(discordUser.id, accessToken);

			return APIResponse.success(c, "Login successful", {
				...result.session,
				redirect_path: storedState.redirect_path,
			} satisfies AuthModel.DiscordCallback.Response);
		} catch (error: any) {
			Logger.error("Discord login failed:", error?.stack || error?.message || error);
			return APIResponse.serverError(c, "Failed to complete the Discord login");
		}
	},
);

router.get(
	"/session",

	APIRouteSpec.authenticated({
		summary: "Get Current Session",
		description: "Retrieve the current user's session information",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Session info retrieved successfully", AuthModel.Session.Response),
			APIResponseSpec.unauthorized(
				"Unauthorized: Invalid or missing session token / Your Auth Context is not a session",
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);
		if (authContext.type !== "session") {
			return APIResponse.unauthorized(c, "Your Auth Context is not a session");
		}

		return APIResponse.success(c, "Session info retrieved successfully", {
			user_id: authContext.user_id,
			user_role: authContext.user_role,
			created_at: authContext.created_at,
			expires_at: authContext.expires_at,
		} satisfies AuthModel.Session.Response);
	},
);

router.post(
	"/logout",

	APIRouteSpec.authenticated({
		summary: "User Logout",
		description: "Invalidate the current user's session",
		tags: [DOCS_TAGS.AUTHENTICATION],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Logout successful"),
			APIResponseSpec.unauthorized(
				"Unauthorized: Invalid or missing session token / Your Auth Context is not a session",
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);

		if (authContext.type !== "session") {
			return APIResponse.unauthorized(c, "Your Auth Context is not a session");
		}

		await SessionHandler.inValidateSession(authContext.id);

		return APIResponse.successNoData(c, "Logout successful");
	},
);
