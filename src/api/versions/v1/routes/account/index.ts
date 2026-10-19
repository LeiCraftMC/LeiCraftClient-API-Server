import { Hono } from "hono";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";
import { DiscordOAuth } from "../../../../utils/discord";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { UserHandler } from "../../../../utils/users";
import { DOCS_TAGS } from "../../docs";
import { AccountModel } from "./model";

export const router = new Hono().basePath("/account");

// all routes below require authentication via session
router.use("*", async (c, next) => {
	const authContext = AuthHandler.AuthContext.get(c);

	if (authContext.type !== "session") {
		return APIResponse.unauthorized(c, "Your Auth Context is not a session");
	}

	await next();
});

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Get account information",
		description:
			"Retrieve the authenticated user's account. Name and avatar come from Discord and are refreshed on every login.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Account information retrieved successfully",
				AccountModel.GetInfo.Response,
			),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const user = await UserHandler.getByID(authContext.user_id);
		if (!user) {
			throw new Error("User not found but session exists");
		}

		const { discord_avatar_hash, ...rest } = user;

		return APIResponse.success(c, "Account information retrieved successfully", {
			...rest,
			avatar_url: DiscordOAuth.getAvatarURL(user.discord_id, discord_avatar_hash),
		} satisfies AccountModel.GetInfo.Response);
	},
);

router.delete(
	"/",

	APIRouteSpec.authenticated({
		summary: "Delete account",
		description:
			"Permanently delete the authenticated user's account: sessions, API keys, preferences, owned items, Minecraft links and the user's community page with its products. Official and partner content stays.",
		tags: [DOCS_TAGS.ACCOUNT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.successNoData("Account deleted successfully"),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		try {
			await DB.instance().transaction(async (tx: DrizzleDB) => {
				await UserHandler.deleteUser(authContext.user_id, tx);
			});

			return APIResponse.successNoData(c, "Account deleted successfully");
		} catch (error: any) {
			Logger.error("Failed to delete account", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to delete account");
		}
	},
);

router.route("/", (await import("./apikeys")).router);
router.route("/", (await import("./preferences")).router);
router.route("/", (await import("./minecraft")).router);
router.route("/", (await import("./inventory")).router);
