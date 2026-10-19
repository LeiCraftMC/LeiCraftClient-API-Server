import { z } from "zod";
import { ModerationSettings } from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace ModerationReportsModel {
	export const Report = z.object({
		id: z.number().int(),
		reporter: SharedViews.PublicUser.nullable(),
		target_type: ModerationSettings.ReportTargetType,
		target_id: z.number().int(),
		reason: ModerationSettings.ReportReason,
		details: z.string(),
		status: ModerationSettings.ReportStatus,
		resolved_by: SharedViews.PublicUser.nullable(),
		resolution_note: z.string().nullable(),
		resolved_at: z.number().int().nullable(),
		created_at: z.number().int(),
	});
	export type Report = z.infer<typeof Report>;
}

export namespace ModerationReportsModel.GetAll {
	export const Query = z.object({
		status: ModerationSettings.ReportStatus.default("open"),
		target_type: ModerationSettings.ReportTargetType.optional(),
		target_id: z.coerce.number().int().positive().optional(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(ModerationReportsModel.Report);
	export type Response = z.infer<typeof Response>;
}

export namespace ModerationReportsModel.ReportId {
	export const Params = z.object({
		reportId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace ModerationReportsModel.Resolve {
	export const Body = z.object({
		status: z.enum(["resolved", "dismissed"]),
		note: z.string().trim().max(500).optional(),
	});
	export type Body = z.infer<typeof Body>;
}
