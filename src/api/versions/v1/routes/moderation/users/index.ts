import { and, desc, eq, exists, isNotNull, isNull, like, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { MinecraftAccountHandler } from "../../../../../utils/minecraftAccounts";
import { UserAccountSettings } from "../../../../../utils/shared-models/accountData";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { UserHandler } from "../../../../../utils/users";
import { DOCS_TAGS } from "../../../docs";
import { ModerationUsersModel } from "./model";

type Variables = { targetUser: DB.Models.User };

export const router = new Hono<{ Variables: Variables }>().basePath("/users");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "Search users",
		description:
			"Find users by display name, Discord username or id, or a linked Minecraft name, optionally only banned ones.",
		tags: [DOCS_TAGS.MODERATION.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Users retrieved successfully", ModerationUsersModel.GetAll.Response),
		),
	}),

	zValidator("query", ModerationUsersModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as ModerationUsersModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [];

		if (query.search) {
			const pattern = `%${query.search}%`;
			conditions.push(
				or(
					like(DB.Tables.users.display_name, pattern),
					like(DB.Tables.users.discord_username, pattern),
					eq(DB.Tables.users.discord_id, query.search),
					exists(
						DB.instance()
							.select({ one: sql`1` })
							.from(DB.Tables.minecraftAccounts)
							.where(
								and(
									eq(DB.Tables.minecraftAccounts.user_id, DB.Tables.users.id),
									like(DB.Tables.minecraftAccounts.name, pattern),
								),
							),
					),
				),
			);
		}

		if (query.banned === true) {
			conditions.push(
				and(
					isNotNull(DB.Tables.users.banned_at),
					or(isNull(DB.Tables.users.banned_until), sql`${DB.Tables.users.banned_until} > ${Date.now()}`),
				),
			);
		} else if (query.banned === false) {
			conditions.push(
				or(isNull(DB.Tables.users.banned_at), sql`${DB.Tables.users.banned_until} <= ${Date.now()}`),
			);
		}

		const users = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(and(...conditions))
			.orderBy(desc(DB.Tables.users.created_at))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(
			c,
			"Users retrieved successfully",
			users.map((user) => CatalogViews.managedUser(user)),
		);
	},
);

router.use(
	"/:userId/*",

	zValidator("param", ModerationUsersModel.UserId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { userId } = c.req.valid("param") as ModerationUsersModel.UserId.Params;

		const user = await UserHandler.getByID(userId);
		if (!user) {
			return APIResponse.notFound(c, "User not found");
		}

		c.set("targetUser", user);

		await next();
	},
);

router.get(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Get user",
		description: "A user with ban state and linked Minecraft accounts.",
		tags: [DOCS_TAGS.MODERATION.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("User retrieved successfully", ModerationUsersModel.Detail.Response),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	async (c) => {
		const user = c.get("targetUser");
		const accounts = await MinecraftAccountHandler.getLinkedAccounts(user.id);

		return APIResponse.success(c, "User retrieved successfully", {
			...CatalogViews.managedUser(user),
			minecraft_accounts: accounts.map((account) => MinecraftAccountHandler.view(account)),
		} satisfies ModerationUsersModel.Detail.Response);
	},
);

router.post(
	"/:userId/ban",

	APIRouteSpec.authenticated({
		summary: "Ban user",
		description:
			"Ban a user permanently or for a number of days: their sessions and API keys are revoked, they can't log in, and their cape and cosmetics stop showing in-game. Moderators can ban users; only admins can ban moderators. Admins can't be banned (demote first).",
		tags: [DOCS_TAGS.MODERATION.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("User banned", ModerationUsersModel.Ban.Response),
			APIResponseSpec.forbidden("You can't ban this user"),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	zValidator("json", ModerationUsersModel.Ban.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const user = c.get("targetUser");
		const body = c.req.valid("json");

		if (user.id === authContext.user_id) {
			return APIResponse.forbidden(c, "You can't ban yourself");
		}
		if (user.role === "admin" || (user.role === "moderator" && authContext.user_role !== "admin")) {
			return APIResponse.forbidden(c, "You can't ban this user");
		}

		const bannedUntil = body.duration_days
			? Date.now() + body.duration_days * 24 * 60 * 60 * 1000
			: null;

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await UserHandler.ban(user.id, body.reason, bannedUntil, tx);
			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "user.ban",
					target_type: "user",
					target_id: user.id,
					details: { reason: body.reason, banned_until: bannedUntil },
				},
				tx,
			);
		});

		const updated = (await UserHandler.getByID(user.id)) as DB.Models.User;
		return APIResponse.success(c, "User banned", CatalogViews.managedUser(updated));
	},
);

router.post(
	"/:userId/unban",

	APIRouteSpec.authenticated({
		summary: "Unban user",
		description: "Lift a ban. Only admins can unban moderators.",
		tags: [DOCS_TAGS.MODERATION.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("User unbanned", ModerationUsersModel.Ban.Response),
			APIResponseSpec.forbidden("You can't unban this user"),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const user = c.get("targetUser");

		if (UserAccountSettings.isStaff(user.role) && authContext.user_role !== "admin") {
			return APIResponse.forbidden(c, "You can't unban this user");
		}

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await UserHandler.unban(user.id, tx);
			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "user.unban",
					target_type: "user",
					target_id: user.id,
				},
				tx,
			);
		});

		const updated = (await UserHandler.getByID(user.id)) as DB.Models.User;
		return APIResponse.success(c, "User unbanned", CatalogViews.managedUser(updated));
	},
);
