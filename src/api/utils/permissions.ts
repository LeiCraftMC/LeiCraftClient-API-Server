import { and, eq } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import type { UserAccountSettings } from "./shared-models/accountData";
import { CatalogSettings } from "./shared-models/catalogData";

/**
 * Who may do what with a page in the studio. Checked inside the handlers (RBAC per the style
 * guide); the global role comes from the auth context, the page role from `page_members`.
 *
 * | action              | admin | page owner              | page manager            |
 * | ------------------- | ----- | ----------------------- | ----------------------- |
 * | view / edit_page    | ✓     | ✓                       | ✓                       |
 * | manage_content      | ✓     | ✓                       | ✓                       |
 * | manage_exclusives   | ✓*    | ✓*                      | ✓*                      |
 * | manage_members      | ✓*    | ✓*                      | –                       |
 * | delete_page         | ✓     | community pages only    | –                       |
 *
 * `*` official and partner pages only — community pages have a single owner and no exclusives.
 * Moderators have no studio rights of their own; they act through the moderation routes.
 */
export class PagePermissions {
	static async getMemberRole(
		pageID: number,
		userID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<CatalogSettings.PageMemberRole | null> {
		const member = await tx
			.select()
			.from(DB.Tables.pageMembers)
			.where(and(eq(DB.Tables.pageMembers.page_id, pageID), eq(DB.Tables.pageMembers.user_id, userID)))
			.get();
		return member?.role ?? null;
	}

	static can(access: PagePermissions.Access, action: PagePermissions.Action): boolean {
		const isAdmin = access.user_role === "admin";
		const isMember = access.member_role !== null;
		const isOwner = access.member_role === "owner";

		switch (action) {
			case "view":
			case "edit_page":
			case "manage_content":
				return isAdmin || isMember;
			case "manage_exclusives":
				return CatalogSettings.supportsExclusives(access.category) && (isAdmin || isMember);
			case "manage_members":
				return access.category !== "community" && (isAdmin || isOwner);
			case "delete_page":
				return isAdmin || (access.category === "community" && isOwner);
		}
	}
}

export namespace PagePermissions {
	export type Action =
		| "view"
		| "edit_page"
		| "manage_content"
		| "manage_exclusives"
		| "manage_members"
		| "delete_page";

	export interface Access {
		user_role: UserAccountSettings.Role;
		member_role: CatalogSettings.PageMemberRole | null;
		category: CatalogSettings.Category;
	}
}
