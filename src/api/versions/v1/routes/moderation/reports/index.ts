import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { ModerationReportsModel } from "./model";

async function reportViews(reports: DB.Models.Report[]): Promise<ModerationReportsModel.Report[]> {
	const userIDs = [
		...new Set(
			reports
				.flatMap((report) => [report.reporter_user_id, report.resolved_by_user_id])
				.filter((id): id is number => id !== null),
		),
	];
	const users = userIDs.length
		? await DB.instance()
				.select()
				.from(DB.Tables.users)
				.where(inArray(DB.Tables.users.id, userIDs))
				.all()
		: [];
	const byID = new Map(users.map((user) => [user.id, CatalogViews.publicUser(user)]));

	return reports.map((report) => ({
		id: report.id,
		reporter: report.reporter_user_id ? (byID.get(report.reporter_user_id) ?? null) : null,
		target_type: report.target_type,
		target_id: report.target_id,
		reason: report.reason,
		details: report.details,
		status: report.status,
		resolved_by: report.resolved_by_user_id ? (byID.get(report.resolved_by_user_id) ?? null) : null,
		resolution_note: report.resolution_note,
		resolved_at: report.resolved_at,
		created_at: report.created_at,
	}));
}

type Variables = { report: DB.Models.Report };

export const router = new Hono<{ Variables: Variables }>().basePath("/reports");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List reports",
		description: "Reports by status — by default the open ones, oldest first.",
		tags: [DOCS_TAGS.MODERATION.REPORTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Reports retrieved successfully",
				ModerationReportsModel.GetAll.Response,
			),
		),
	}),

	zValidator("query", ModerationReportsModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as ModerationReportsModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [eq(DB.Tables.reports.status, query.status)];
		if (query.target_type) conditions.push(eq(DB.Tables.reports.target_type, query.target_type));
		if (query.target_id) conditions.push(eq(DB.Tables.reports.target_id, query.target_id));

		const reports = await DB.instance()
			.select()
			.from(DB.Tables.reports)
			.where(and(...conditions))
			.orderBy(
				query.status === "open"
					? asc(DB.Tables.reports.created_at)
					: desc(DB.Tables.reports.resolved_at),
			)
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(c, "Reports retrieved successfully", await reportViews(reports));
	},
);

router.use(
	"/:reportId/*",

	zValidator("param", ModerationReportsModel.ReportId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { reportId } = c.req.valid("param") as ModerationReportsModel.ReportId.Params;

		const report = await DB.instance()
			.select()
			.from(DB.Tables.reports)
			.where(eq(DB.Tables.reports.id, reportId))
			.get();
		if (!report) {
			return APIResponse.notFound(c, "Report not found");
		}

		c.set("report", report);

		await next();
	},
);

router.get(
	"/:reportId",

	APIRouteSpec.authenticated({
		summary: "Get report",
		description: "One report.",
		tags: [DOCS_TAGS.MODERATION.REPORTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Report retrieved successfully", ModerationReportsModel.Report),
			APIResponseSpec.notFound("Report not found"),
		),
	}),

	async (c) => {
		const [view] = await reportViews([c.get("report")]);
		return APIResponse.success(
			c,
			"Report retrieved successfully",
			view as ModerationReportsModel.Report,
		);
	},
);

router.post(
	"/:reportId/resolve",

	APIRouteSpec.authenticated({
		summary: "Resolve report",
		description:
			"Close a report as `resolved` (action taken — e.g. product disabled, user banned) or `dismissed`. Taking the action itself is a separate call.",
		tags: [DOCS_TAGS.MODERATION.REPORTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Report closed", ModerationReportsModel.Report),
			APIResponseSpec.notFound("Report not found"),
			APIResponseSpec.conflict("The report is already closed"),
		),
	}),

	zValidator("json", ModerationReportsModel.Resolve.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const report = c.get("report");
		const body = c.req.valid("json");

		if (report.status !== "open") {
			return APIResponse.conflict(c, "The report is already closed");
		}

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const updated = await tx
				.update(DB.Tables.reports)
				.set({
					status: body.status,
					resolution_note: body.note ?? null,
					resolved_by_user_id: authContext.user_id,
					resolved_at: Date.now(),
				})
				.where(eq(DB.Tables.reports.id, report.id))
				.returning()
				.get();

			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "report.resolve",
					target_type: "report",
					target_id: report.id,
					details: { status: body.status, note: body.note ?? null },
				},
				tx,
			);

			return updated;
		});

		const [view] = await reportViews([updated]);
		return APIResponse.success(c, "Report closed", view as ModerationReportsModel.Report);
	},
);
