import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuthHandler } from "../../../../../utils/authHandler";
import { LoadoutHandler } from "../../../../../utils/loadouts";
import { MinecraftAccountHandler } from "../../../../../utils/minecraftAccounts";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AccountMinecraftModel } from "./model";

type Variables = { minecraftAccount: DB.Models.MinecraftAccount };

export const router = new Hono<{ Variables: Variables }>().basePath("/minecraft");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List linked Minecraft accounts",
		description: "Retrieve the Minecraft accounts linked to the authenticated user.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Minecraft accounts retrieved successfully",
				AccountMinecraftModel.GetAll.Response,
			),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		const accounts = await MinecraftAccountHandler.getLinkedAccounts(authContext.user_id);

		return APIResponse.success(
			c,
			"Minecraft accounts retrieved successfully",
			accounts.map((account) => MinecraftAccountHandler.view(account)),
		);
	},
);

router.get(
	"/link/:code",

	APIRouteSpec.authenticated({
		summary: "Preview a Minecraft link code",
		description:
			"Show which Minecraft account a link code (from the link the mod opened) belongs to, so the user can confirm before linking.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Link code is valid", AccountMinecraftModel.LinkPreview.Response),
			APIResponseSpec.notFound("Invalid or expired link code"),
		),
	}),

	zValidator("param", AccountMinecraftModel.LinkPreview.Params),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const { code } = c.req.valid("param");

		const resolved = await MinecraftAccountHandler.resolveLinkCode(code);
		if (!resolved) {
			return APIResponse.notFound(c, "Invalid or expired link code");
		}

		return APIResponse.success(c, "Link code is valid", {
			account: MinecraftAccountHandler.view(resolved.account),
			expires_at: resolved.linkCode.expires_at,
			linked_to_you: resolved.account.user_id === authContext.user_id,
			linked_to_other_user:
				resolved.account.user_id !== null && resolved.account.user_id !== authContext.user_id,
		} satisfies AccountMinecraftModel.LinkPreview.Response);
	},
);

router.post(
	"/link",

	APIRouteSpec.authenticated({
		summary: "Link a Minecraft account",
		description:
			"Consume a link code and link its Minecraft account to the authenticated user. Each user can link up to 5 Minecraft accounts; every linked account has its own loadout.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Minecraft account linked successfully",
				AccountMinecraftModel.Link.Response,
			),
			APIResponseSpec.badRequest(
				"Invalid or expired link code / Syntax or validation error in request",
			),
			APIResponseSpec.conflict(
				"Minecraft account already linked / Maximum number of linked accounts reached",
			),
		),
	}),

	zValidator("json", AccountMinecraftModel.Link.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);
		const { code } = c.req.valid("json");

		const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
			return await MinecraftAccountHandler.link(code, authContext.user_id, tx);
		});

		if (!result.ok) {
			return result.code === 409
				? APIResponse.conflict(c, result.message)
				: APIResponse.badRequest(c, result.message);
		}

		return APIResponse.success(
			c,
			"Minecraft account linked successfully",
			MinecraftAccountHandler.view(result.account),
		);
	},
);

router.use(
	"/:uuid/*",

	zValidator("param", AccountMinecraftModel.Account.Params),

	async (c, next) => {
		const authContext = AuthHandler.AuthContext.getAsSession(c);

		// @ts-ignore - hono-openapi does not type "param" yet
		const { uuid } = c.req.valid("param") as AccountMinecraftModel.Account.Params;

		const account = await MinecraftAccountHandler.getLinkedAccount(authContext.user_id, uuid);
		if (!account) {
			return APIResponse.notFound(c, "Minecraft account not found");
		}

		c.set("minecraftAccount", account);

		await next();
	},
);

router.delete(
	"/:uuid",

	APIRouteSpec.authenticated({
		summary: "Unlink a Minecraft account",
		description:
			"Unlink a Minecraft account from the authenticated user. Its loadout is cleared; owned items stay with the user.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Minecraft account unlinked successfully"),
			APIResponseSpec.notFound("Minecraft account not found"),
		),
	}),

	async (c) => {
		const account = c.get("minecraftAccount");

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await MinecraftAccountHandler.unlink(account.id, tx);
		});

		return APIResponse.successNoData(c, "Minecraft account unlinked successfully");
	},
);

router.get(
	"/:uuid/loadout",

	APIRouteSpec.authenticated({
		summary: "Get loadout",
		description:
			"Retrieve the cape and cosmetics equipped on a linked Minecraft account. Items that currently can't show in-game (taken down, no longer owned) are left out.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Loadout retrieved successfully",
				AccountMinecraftModel.Loadout.Response,
			),
			APIResponseSpec.notFound("Minecraft account not found"),
		),
	}),

	async (c) => {
		const loadout = await LoadoutHandler.getLoadout(c.get("minecraftAccount"));

		return APIResponse.success(c, "Loadout retrieved successfully", loadout);
	},
);

router.put(
	"/:uuid/loadout",

	APIRouteSpec.authenticated({
		summary: "Set loadout",
		description:
			"Replace the cape and cosmetics equipped on a linked Minecraft account. Every product must be published; exclusive products must be owned. At most 10 cosmetics.",
		tags: [DOCS_TAGS.ACCOUNT_MINECRAFT],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Loadout updated successfully", AccountMinecraftModel.Loadout.Response),
			APIResponseSpec.badRequest(
				"Product not available / Invalid variant / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("You do not own this product"),
			APIResponseSpec.notFound("Minecraft account not found"),
		),
	}),

	zValidator("json", AccountMinecraftModel.Loadout.Body),

	async (c) => {
		const account = c.get("minecraftAccount");
		const body = c.req.valid("json");

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
