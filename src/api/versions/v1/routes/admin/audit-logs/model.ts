import { z } from "zod";
import { AuditLog } from "../../../../../utils/auditLog";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace AdminAuditLogsModel.GetAll {
	export const Query = z.object({
		actor_user_id: z.coerce.number().int().positive().optional(),
		action: z.enum(AuditLog.Actions).optional(),
		target_type: z.enum(AuditLog.TargetTypes).optional(),
		target_id: z.string().min(1).max(64).optional(),
		limit: z.coerce.number().int().min(1).max(500).default(100),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(
		z.object({
			id: z.number().int(),
			actor: SharedViews.PublicUser.nullable(),
			action: z.string(),
			target_type: z.string(),
			target_id: z.string().nullable(),
			details: z.record(z.string(), z.any()),
			created_at: z.number().int(),
		}),
	);
	export type Response = z.infer<typeof Response>;
}
