import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { LCrypt } from "../../../../../utils/crypto/lcrypt";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler, ClientSessionHandler } from "../../../../utils/authHandler";
import { CatalogViews } from "../../../../utils/catalogViews";
import { LoadoutHandler } from "../../../../utils/loadouts";
import { MinecraftAccountHandler } from "../../../../utils/minecraftAccounts";
import { MojangSessionService } from "../../../../utils/mojang";
import { RateLimiter, RequestUtils } from "../../../../utils/rateLimiter";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { UserHandler } from "../../../../utils/users";
import { WardrobeHandler } from "../../../../utils/wardrobe";
import { DOCS_TAGS } from "../../docs";
import { AccountMinecraftModel } from "../account/minecraft/model";
import { ClientModel } from "./model";

const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;

const challengeLimiter = new RateLimiter(30, 60 * 1000);
const verifyLimiter = new RateLimiter(30, 60 * 1000);
const linkLimiter = new RateLimiter(10, 10 * 60 * 1000);

type Variables = { minecraftAccount: DB.Models.MinecraftAccount };

async function getLinkedUser(account: DB.Models.MinecraftAccount) {
	if (account.user_id === null) return null;
	const user = await UserHandler.getByID(account.user_id);
	return user ? CatalogViews.publicUser(user) : null;
}

export const router = new Hono<{ Variables: Variables }>().basePath("/client");

// ─── Handshake (no client session yet) ──────────────────────────────────────────────────────
// Registered before the session guard below, so these two routes answer without one.

router.post(
	"/auth/challenge",

	APIRouteSpec.unauthenticated({
		summary: "Start the Minecraft handshake",
		description:
			"Step 1 of the mod login. Returns a short-lived `server_id`. The mod passes it to Mojang's `joinServer(profileId, accessToken, serverId)` (authlib `MinecraftSessionService`) and then calls `/client/auth/verify`. The access token never leaves the game.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Challenge created", ClientModel.Challenge.Response),
			APIResponseSpec.tooManyRequests("Too many requests. Try again later."),
		),
	}),

	async (c) => {
		const limit = challengeLimiter.hit(RequestUtils.getClientIP(c));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many requests. Try again later.");
		}

		const challenge = await DB.instance()
			.insert(DB.Tables.clientAuthChallenges)
			.values({
				id: LCrypt.randomBytes(16).toString("hex"),
				// 40 hex chars, the length of a vanilla server hash
				server_id: LCrypt.randomBytes(20).toString("hex"),
				expires_at: Date.now() + CHALLENGE_LIFETIME_MS,
			})
			.returning()
			.get();

		return APIResponse.success(c, "Challenge created", {
			challenge_id: challenge.id,
			server_id: challenge.server_id,
			expires_at: challenge.expires_at,
		} satisfies ClientModel.Challenge.Response);
	},
);

router.post(
	"/auth/verify",

	APIRouteSpec.unauthenticated({
		summary: "Finish the Minecraft handshake",
		description:
			"Step 2 of the mod login. Asks Mojang's session server whether `username` joined with the challenge's `server_id`. On success the Minecraft account is created or refreshed (name, skin) and a client session token is returned. Challenges are single-use and expire after 2 minutes.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Minecraft account verified", ClientModel.Verify.Response),
			APIResponseSpec.badRequest(
				"Invalid or expired challenge / Syntax or validation error in request",
			),
			APIResponseSpec.unauthorized("Mojang did not confirm the session"),
			APIResponseSpec.tooManyRequests("Too many requests. Try again later."),
			APIResponseSpec.serverError("Could not reach the Mojang session server"),
		),
	}),

	zValidator("json", ClientModel.Verify.Body),

	async (c) => {
		const limit = verifyLimiter.hit(RequestUtils.getClientIP(c));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many requests. Try again later.");
		}

		const { challenge_id, username } = c.req.valid("json");

		const challenge = await DB.instance()
			.delete(DB.Tables.clientAuthChallenges)
			.where(eq(DB.Tables.clientAuthChallenges.id, challenge_id))
			.returning()
			.get();

		if (!challenge || challenge.expires_at < Date.now()) {
			return APIResponse.badRequest(c, "Invalid or expired challenge");
		}

		let profile: MojangSessionService.Profile | null;
		try {
			profile = await MojangSessionService.hasJoined(username, challenge.server_id);
		} catch (error: any) {
			Logger.error("Mojang session check failed:", error?.message || error);
			return APIResponse.serverError(c, "Could not reach the Mojang session server");
		}

		if (!profile) {
			return APIResponse.unauthorized(c, "Mojang did not confirm the session");
		}

		const verifiedProfile = profile;
		const { account, session } = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const account = await MinecraftAccountHandler.upsertVerified(verifiedProfile, tx);
			const session = await ClientSessionHandler.createClientSession(account.id, tx);
			return { account, session };
		});

		return APIResponse.success(c, "Minecraft account verified", {
			token: session.token,
			expires_at: session.expires_at,
			account: MinecraftAccountHandler.view(account),
			user: await getLinkedUser(account),
		} satisfies ClientModel.Verify.Response);
	},
);

// ─── Everything below needs a client session ────────────────────────────────────────────────

router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (authContext.type !== "clientSession") {
		return APIResponse.unauthorized(c, "This endpoint requires a client session");
	}

	const account = await MinecraftAccountHandler.getByID(authContext.minecraft_account_id);
	if (!account) {
		return APIResponse.unauthorized(c, "This endpoint requires a client session");
	}

	await MinecraftAccountHandler.touch(account);

	c.set("minecraftAccount", account);

	await next();
});

router.get(
	"/session",

	APIRouteSpec.authenticated({
		summary: "Get client session",
		description: "The Minecraft account of the client session and the LeiCraft user it is linked to.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Client session retrieved successfully", ClientModel.Session.Response),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsClientSession(c);
		const account = c.get("minecraftAccount");

		return APIResponse.success(c, "Client session retrieved successfully", {
			account: MinecraftAccountHandler.view(account),
			user: await getLinkedUser(account),
			expires_at: authContext.expires_at,
		} satisfies ClientModel.Session.Response);
	},
);

router.post(
	"/logout",

	APIRouteSpec.authenticated({
		summary: "End client session",
		description: "Invalidate the current client session token.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Client session ended"),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsClientSession(c);

		await ClientSessionHandler.inValidateClientSession(authContext.id);

		return APIResponse.successNoData(c, "Client session ended");
	},
);

router.get(
	"/link",

	APIRouteSpec.authenticated({
		summary: "Get link status",
		description:
			"Whether the Minecraft account is linked to a LeiCraft user. Poll this after opening the link URL to notice when the user confirmed it on the website.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Link status retrieved successfully", ClientModel.LinkStatus.Response),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
		),
	}),

	async (c) => {
		const account = c.get("minecraftAccount");
		const pending =
			account.user_id === null ? await MinecraftAccountHandler.getPendingLinkCode(account.id) : null;

		return APIResponse.success(c, "Link status retrieved successfully", {
			linked: account.user_id !== null,
			user: await getLinkedUser(account),
			pending_code_expires_at: pending?.expires_at ?? null,
		} satisfies ClientModel.LinkStatus.Response);
	},
);

router.post(
	"/link",

	APIRouteSpec.authenticated({
		summary: "Create link",
		description:
			"Create a one-time link (valid 10 minutes) for linking this Minecraft account to a LeiCraft account. Show `url` as a clickable link in the game; the website asks the user to log in with Discord and confirm. Creating a new link invalidates the previous one.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Link created", ClientModel.CreateLink.Response),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
			APIResponseSpec.conflict("This Minecraft account is already linked"),
			APIResponseSpec.tooManyRequests("Too many requests. Try again later."),
		),
	}),

	async (c) => {
		const account = c.get("minecraftAccount");

		if (account.user_id !== null) {
			return APIResponse.conflict(c, "This Minecraft account is already linked");
		}

		const limit = linkLimiter.hit(String(account.id));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many requests. Try again later.");
		}

		const link = await DB.instance().transaction(async (tx: DrizzleDB) => {
			return await MinecraftAccountHandler.createLinkCode(account.id, tx);
		});

		return APIResponse.success(c, "Link created", link satisfies ClientModel.CreateLink.Response);
	},
);

router.delete(
	"/link",

	APIRouteSpec.authenticated({
		summary: "Unlink from the game",
		description:
			"Unlink this Minecraft account from its LeiCraft user — proven ownership of the Minecraft account is enough. The loadout is cleared.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Minecraft account unlinked successfully"),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
			APIResponseSpec.badRequest("This Minecraft account is not linked"),
		),
	}),

	async (c) => {
		const account = c.get("minecraftAccount");

		if (account.user_id === null) {
			return APIResponse.badRequest(c, "This Minecraft account is not linked");
		}

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await MinecraftAccountHandler.unlink(account.id, tx);
		});

		return APIResponse.successNoData(c, "Minecraft account unlinked successfully");
	},
);

router.get(
	"/wardrobe",

	APIRouteSpec.authenticated({
		summary: "List wardrobe",
		description:
			"For the in-game wardrobe: the linked user's wardrobe — the exclusive products they own (always there) plus the free products they saved or equipped (owned first, then the most recently saved). New items are found in the shop on the website. Needs a linked account.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Wardrobe retrieved successfully", ClientModel.Wardrobe.Response),
			APIResponseSpec.badRequest(
				"This Minecraft account is not linked / Syntax or validation error in request",
			),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
		),
	}),

	zValidator("query", ClientModel.Wardrobe.Query),

	async (c) => {
		const account = c.get("minecraftAccount");
		if (account.user_id === null) {
			return APIResponse.badRequest(c, "This Minecraft account is not linked");
		}

		const query = c.req.valid("query") as ClientModel.Wardrobe.Query;

		return APIResponse.success(
			c,
			"Wardrobe retrieved successfully",
			await WardrobeHandler.list(account.user_id, query),
		);
	},
);

router.get(
	"/loadout",

	APIRouteSpec.authenticated({
		summary: "Get own loadout",
		description: "The cape and cosmetics equipped on the client session's Minecraft account.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Loadout retrieved successfully",
				AccountMinecraftModel.Loadout.Response,
			),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
		),
	}),

	async (c) => {
		const loadout = await LoadoutHandler.getLoadout(c.get("minecraftAccount"));

		return APIResponse.success(c, "Loadout retrieved successfully", loadout);
	},
);

router.put(
	"/loadout",

	APIRouteSpec.authenticated({
		summary: "Set own loadout",
		description:
			"Replace the loadout of the client session's Minecraft account (for an in-game wardrobe). Needs a linked account; same rules as the website's `PUT /account/minecraft/{uuid}/loadout`.",
		tags: [DOCS_TAGS.CLIENT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Loadout updated successfully", AccountMinecraftModel.Loadout.Response),
			APIResponseSpec.badRequest(
				"Account not linked / Product not available / Syntax or validation error in request",
			),
			APIResponseSpec.unauthorized("This endpoint requires a client session"),
			APIResponseSpec.forbidden("You do not own this product / The linked account is banned"),
		),
	}),

	zValidator("json", AccountMinecraftModel.Loadout.Body),

	async (c) => {
		const account = c.get("minecraftAccount");
		const body = c.req.valid("json");

		if (account.user_id !== null) {
			const user = await UserHandler.getByID(account.user_id);
			if (user && UserHandler.isBanned(user)) {
				return APIResponse.forbidden(c, "The linked account is banned");
			}
		}

		const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
			return await LoadoutHandler.setLoadout(account, body, tx);
		});

		if (!result.ok) {
			return result.code === 403
				? APIResponse.forbidden(c, result.message)
				: APIResponse.badRequest(c, result.message);
		}

		const loadout = await LoadoutHandler.getLoadout(
			(await MinecraftAccountHandler.getByID(account.id)) ?? account,
		);

		return APIResponse.success(c, "Loadout updated successfully", loadout);
	},
);
