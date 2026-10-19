import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { APIResponse } from "../../../../utils/api-res";
import { AuthHandler } from "../../../../utils/authHandler";
import { RateLimiter } from "../../../../utils/rateLimiter";
import type { ModerationSettings } from "../../../../utils/shared-models/catalogData";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { ReportsModel } from "./model";

const reportLimiter = new RateLimiter(10, 60 * 60 * 1000);

async function targetExists(type: ModerationSettings.ReportTargetType, id: number) {
	const table = {
		product: DB.Tables.products,
		page: DB.Tables.pages,
		collection: DB.Tables.collections,
		user: DB.Tables.users,
	}[type];

	const row = await DB.instance().select({ id: table.id }).from(table).where(eq(table.id, id)).get();
	return !!row;
}

export const router = new Hono().basePath("/reports");

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Report content",
		description:
			"Report a product, page, collection or user to the moderators. Limited to 10 reports per hour.",
		tags: [DOCS_TAGS.REPORTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Report submitted successfully", ReportsModel.Create.Response),
			APIResponseSpec.badRequest("Syntax or validation error in request"),
			APIResponseSpec.unauthorized("Your Auth Context is not a session"),
			APIResponseSpec.notFound("The reported item does not exist"),
			APIResponseSpec.conflict("You already reported this"),
			APIResponseSpec.tooManyRequests("Too many reports. Try again later."),
		),
	}),

	zValidator("json", ReportsModel.Create.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.get(c);
		if (authContext.type !== "session") {
			return APIResponse.unauthorized(c, "Your Auth Context is not a session");
		}

		const body = c.req.valid("json");

		const limit = reportLimiter.hit(String(authContext.user_id));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Too many reports. Try again later.");
		}

		if (!(await targetExists(body.target_type, body.target_id))) {
			return APIResponse.notFound(c, "The reported item does not exist");
		}

		const duplicate = await DB.instance()
			.select({ id: DB.Tables.reports.id })
			.from(DB.Tables.reports)
			.where(
				and(
					eq(DB.Tables.reports.reporter_user_id, authContext.user_id),
					eq(DB.Tables.reports.target_type, body.target_type),
					eq(DB.Tables.reports.target_id, body.target_id),
					eq(DB.Tables.reports.status, "open"),
				),
			)
			.get();
		if (duplicate) {
			return APIResponse.conflict(c, "You already reported this");
		}

		const report = await DB.instance()
			.insert(DB.Tables.reports)
			.values({
				reporter_user_id: authContext.user_id,
				target_type: body.target_type,
				target_id: body.target_id,
				reason: body.reason,
				details: body.details ?? "",
			})
			.returning()
			.get();

		return APIResponse.created(c, "Report submitted successfully", {
			id: report.id,
			target_type: report.target_type,
			target_id: report.target_id,
			reason: report.reason,
			details: report.details,
			status: report.status,
			created_at: report.created_at,
		} satisfies ReportsModel.Report);
	},
);
