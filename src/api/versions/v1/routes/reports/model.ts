import { z } from "zod";
import { ModerationSettings } from "../../../../utils/shared-models/catalogData";

export namespace ReportsModel {
	export const Report = z.object({
		id: z.number().int(),
		target_type: ModerationSettings.ReportTargetType,
		target_id: z.number().int(),
		reason: ModerationSettings.ReportReason,
		details: z.string(),
		status: ModerationSettings.ReportStatus,
		created_at: z.number().int(),
	});
	export type Report = z.infer<typeof Report>;
}

export namespace ReportsModel.Create {
	export const Body = z.object({
		target_type: ModerationSettings.ReportTargetType,
		target_id: z.number().int().positive(),
		reason: ModerationSettings.ReportReason,
		details: z.string().trim().max(2000).optional(),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = ReportsModel.Report;
	export type Response = z.infer<typeof Response>;
}
