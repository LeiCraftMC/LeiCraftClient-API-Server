import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { type DrizzleDB } from "../../../../../db/utils";
import { Logger } from "../../../../../utils/logger";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";
import { DiscordOAuth } from "../../../../utils/discord";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { UserHandler } from "../../../../utils/users";
import { WardrobeHandler } from "../../../../utils/wardrobe";
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

router.get(
	"/wardrobe",

	APIRouteSpec.authenticated({
		summary: "List wardrobe",
		description:
			"The user's wardrobe: the exclusive products they own (always there) plus the free products they saved or equipped. Owned exclusives come first, then the most recently saved. Only public products show.",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Wardrobe retrieved successfully", AccountModel.Wardrobe.Response),
		),
	}),

	zValidator("query", AccountModel.Wardrobe.Query),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const query = c.req.valid("query") as AccountModel.Wardrobe.Query;

		return APIResponse.success(
			c,
			"Wardrobe retrieved successfully",
			await WardrobeHandler.list(authContext.user_id, query),
		);
	},
);

router.get(
	"/wardrobe/:productId",

	APIRouteSpec.authenticated({
		summary: "Get wardrobe status of a product",
		description:
			"Whether a product is in the user's wardrobe and whether it can be removed (owned exclusives can't). Unknown products are simply not in it.",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Wardrobe status retrieved successfully",
				AccountModel.WardrobeItem.Response,
			),
		),
	}),

	zValidator("param", AccountModel.WardrobeItem.Params),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const { productId } = c.req.valid("param");

		return APIResponse.success(
			c,
			"Wardrobe status retrieved successfully",
			await WardrobeHandler.status(authContext.user_id, productId),
		);
	},
);

router.put(
	"/wardrobe/:productId",

	APIRouteSpec.authenticated({
		summary: "Save to wardrobe",
		description:
			"Save a public free product to the wardrobe without equipping it (idempotent). Exclusive products join the wardrobe by owning them — saving one you own is a no-op, one you don't own answers 403. At most 500 saved items.",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Saved to your wardrobe", AccountModel.WardrobeItem.Response),
			APIResponseSpec.forbidden("You do not own this exclusive product"),
			APIResponseSpec.notFound("Product not found"),
			APIResponseSpec.conflict("Your wardrobe is full"),
		),
	}),

	zValidator("param", AccountModel.WardrobeItem.Params),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const { productId } = c.req.valid("param");

		const result = await WardrobeHandler.add(authContext.user_id, productId);
		if (!result.ok) {
			return wardrobeError(c, result);
		}

		return APIResponse.success(
			c,
			"Saved to your wardrobe",
			await WardrobeHandler.status(authContext.user_id, productId),
		);
	},
);

router.delete(
	"/wardrobe/:productId",

	APIRouteSpec.authenticated({
		summary: "Remove from wardrobe",
		description:
			"Remove a saved product from the wardrobe. It is also taken off every linked Minecraft account that wears it. Exclusive products the user owns can't be removed (409).",
		tags: [DOCS_TAGS.ACCOUNT_INVENTORY],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Removed from your wardrobe", AccountModel.WardrobeItem.Response),
			APIResponseSpec.notFound("This item is not in your wardrobe"),
			APIResponseSpec.conflict("Exclusive items you own always stay in your wardrobe"),
		),
	}),

	zValidator("param", AccountModel.WardrobeItem.Params),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const { productId } = c.req.valid("param");

		const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
			return await WardrobeHandler.remove(authContext.user_id, productId, tx);
		});
		if (!result.ok) {
			return wardrobeError(c, result);
		}

		return APIResponse.success(
			c,
			"Removed from your wardrobe",
			await WardrobeHandler.status(authContext.user_id, productId),
		);
	},
);

function wardrobeError(c: Context, result: Extract<WardrobeHandler.ChangeResult, { ok: false }>) {
	switch (result.code) {
		case 403:
			return APIResponse.forbidden(c, result.message);
		case 404:
			return APIResponse.notFound(c, result.message);
		case 409:
			return APIResponse.conflict(c, result.message);
	}
}

router.route("/", (await import("./apikeys")).router);
router.route("/", (await import("./preferences")).router);
router.route("/", (await import("./minecraft")).router);
router.route("/", (await import("./inventory")).router);
