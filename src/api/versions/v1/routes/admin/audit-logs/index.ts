import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { APIResponse } from "../../../../../utils/api-res";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AdminAuditLogsModel } from "./model";

export const router = new Hono().basePath("/audit-logs");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List audit log entries",
		description:
			"Moderation, administration and studio actions on shared content (role changes, bans, takedowns, grants, codes, member changes …), newest first.",
		tags: [DOCS_TAGS.ADMIN_API.AUDIT_LOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Audit log retrieved successfully", AdminAuditLogsModel.GetAll.Response),
		),
	}),

	zValidator("query", AdminAuditLogsModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as AdminAuditLogsModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [];
		if (query.actor_user_id)
			conditions.push(eq(DB.Tables.auditLogs.actor_user_id, query.actor_user_id));
		if (query.action) conditions.push(eq(DB.Tables.auditLogs.action, query.action));
		if (query.target_type) conditions.push(eq(DB.Tables.auditLogs.target_type, query.target_type));
		if (query.target_id) conditions.push(eq(DB.Tables.auditLogs.target_id, query.target_id));

		const entries = await DB.instance()
			.select()
			.from(DB.Tables.auditLogs)
			.where(and(...conditions))
			.orderBy(desc(DB.Tables.auditLogs.created_at), desc(DB.Tables.auditLogs.id))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		const actorIDs = [
			...new Set(
				entries.map((entry) => entry.actor_user_id).filter((id): id is number => id !== null),
			),
		];
		const actors = actorIDs.length
			? await DB.instance()
					.select()
					.from(DB.Tables.users)
					.where(inArray(DB.Tables.users.id, actorIDs))
					.all()
			: [];
		const actorsByID = new Map(actors.map((user) => [user.id, CatalogViews.publicUser(user)]));

		return APIResponse.success(
			c,
			"Audit log retrieved successfully",
			entries.map((entry) => ({
				id: entry.id,
				actor: entry.actor_user_id ? (actorsByID.get(entry.actor_user_id) ?? null) : null,
				action: entry.action,
				target_type: entry.target_type,
				target_id: entry.target_id,
				details: entry.details,
				created_at: entry.created_at,
			})) satisfies AdminAuditLogsModel.GetAll.Response,
		);
	},
);
