import { and, asc, eq, like, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { Logger } from "../../../../../../utils/logger";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { SharedViews } from "../../../../../utils/shared-models/views";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { UserHandler } from "../../../../../utils/users";
import { DOCS_TAGS } from "../../../docs";
import { AdminUsersModel } from "./model";

type Variables = { targetUser: DB.Models.User };

export const router = new Hono<{ Variables: Variables }>().basePath("/users");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List users",
		description: "Retrieve user accounts with optional role and search filters.",
		tags: [DOCS_TAGS.ADMIN_API.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Users retrieved successfully", AdminUsersModel.GetAll.Response),
		),
	}),

	zValidator("query", AdminUsersModel.GetAll.Query),

	async (c) => {
		const filters = c.req.valid("query") as AdminUsersModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [];
		if (filters.role) {
			conditions.push(eq(DB.Tables.users.role, filters.role));
		}
		if (filters.search) {
			const pattern = `%${filters.search}%`;
			conditions.push(
				or(
					like(DB.Tables.users.display_name, pattern),
					like(DB.Tables.users.discord_username, pattern),
					eq(DB.Tables.users.discord_id, filters.search),
				),
			);
		}

		const users = await DB.instance()
			.select()
			.from(DB.Tables.users)
			.where(and(...conditions))
			.orderBy(asc(DB.Tables.users.id))
			.limit(filters.limit)
			.offset(filters.offset)
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

	zValidator("param", AdminUsersModel.UserId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { userId } = c.req.valid("param") as AdminUsersModel.UserId.Params;

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
		description: "Retrieve details for a specific user account.",
		tags: [DOCS_TAGS.ADMIN_API.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("User retrieved successfully", SharedViews.ManagedUser),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	async (c) => {
		return APIResponse.success(
			c,
			"User retrieved successfully",
			CatalogViews.managedUser(c.get("targetUser")),
		);
	},
);

router.put(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Change user role",
		description:
			"Make a user an admin, moderator or regular user. Takes effect immediately on all their sessions and API keys. You can't change your own role.",
		tags: [DOCS_TAGS.ADMIN_API.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("User updated successfully", AdminUsersModel.Update.Response),
			APIResponseSpec.forbidden("You can't change your own role"),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	zValidator("json", AdminUsersModel.Update.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const user = c.get("targetUser");
		const { role } = c.req.valid("json");

		if (user.id === authContext.user_id) {
			return APIResponse.forbidden(c, "You can't change your own role");
		}

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const updated = await tx
				.update(DB.Tables.users)
				.set({ role })
				.where(eq(DB.Tables.users.id, user.id))
				.returning()
				.get();

			if (role !== user.role) {
				await AuthHandler.changeUserRoleInAuthContexts(user.id, role, tx);
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "user.role_change",
						target_type: "user",
						target_id: user.id,
						details: { from: user.role, to: role },
					},
					tx,
				);
			}

			return updated;
		});

		return APIResponse.success(c, "User updated successfully", CatalogViews.managedUser(updated));
	},
);

router.delete(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Delete user",
		description:
			"Permanently remove a user account and everything that belongs only to them (see `DELETE /account`).",
		tags: [DOCS_TAGS.ADMIN_API.USERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("User deleted successfully"),
			APIResponseSpec.forbidden("Use DELETE /account to delete your own account"),
			APIResponseSpec.notFound("User not found"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const user = c.get("targetUser");

		if (user.id === authContext.user_id) {
			return APIResponse.forbidden(c, "Use DELETE /account to delete your own account");
		}

		try {
			await DB.instance().transaction(async (tx: DrizzleDB) => {
				await UserHandler.deleteUser(user.id, tx);
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "user.delete",
						target_type: "user",
						target_id: user.id,
						details: { discord_id: user.discord_id, discord_username: user.discord_username },
					},
					tx,
				);
			});
		} catch (error: any) {
			Logger.error("Failed to delete user", error.stack || error.message || error);
			return APIResponse.serverError(c, "Failed to delete user");
		}

		return APIResponse.successNoData(c, "User deleted successfully");
	},
);
