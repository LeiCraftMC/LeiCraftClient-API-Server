import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";

/** Records moderation, administration and shared-content actions in `audit_logs`. */
export class AuditLog {
	static async record(entry: AuditLog.Entry, tx: DrizzleDB = DB.instance()) {
		await tx.insert(DB.Tables.auditLogs).values({
			actor_user_id: entry.actor_user_id,
			action: entry.action,
			target_type: entry.target_type,
			target_id: entry.target_id === null ? null : String(entry.target_id),
			details: entry.details ?? {},
		});
	}
}

export namespace AuditLog {
	export const Actions = [
		"user.role_change",
		"user.ban",
		"user.unban",
		"user.delete",
		"page.create",
		"page.update",
		"page.delete",
		"page.hide",
		"page.unhide",
		"page.member_add",
		"page.member_update",
		"page.member_remove",
		"page.approve_changes",
		"page.reject_changes",
		"collection.create",
		"collection.update",
		"collection.delete",
		"product.create",
		"product.update",
		"product.publish",
		"product.unpublish",
		"variant.create",
		"variant.update",
		"variant.delete",
		"product.approve",
		"product.reject",
		"product.disable",
		"product.restore",
		"product.delete",
		"product.grant",
		"product.revoke",
		"code.create",
		"code.update",
		"code.delete",
		"report.resolve",
		"release.create",
		"release.update",
		"release.delete",
		"release.retry",
	] as const;
	export type Action = (typeof Actions)[number];

	export const TargetTypes = ["user", "page", "collection", "product", "code", "report", "release"] as const;
	export type TargetType = (typeof TargetTypes)[number];

	export interface Entry {
		actor_user_id: number | null;
		action: Action;
		target_type: TargetType;
		target_id: number | string | null;
		details?: Record<string, any>;
	}
}
