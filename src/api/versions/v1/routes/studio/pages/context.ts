import type { Context } from "hono";
import type { DB } from "../../../../../../db";
import { APIResponse } from "../../../../../utils/api-res";
import { PagePermissions } from "../../../../../utils/permissions";

/** Set by the `/:pageId/*` middleware of the studio pages router. */
export type StudioPageVariables = {
	page: DB.Models.Page;
	pageAccess: PagePermissions.Access;
};

export type StudioPageEnv = { Variables: StudioPageVariables };

// The helpers take `Context<any>` so sub-routers whose Variables extend StudioPageVariables can
// pass their context; the values are read with the casts below.
export class StudioPageContext {
	static getAccess(c: Context<any>) {
		return c.get("pageAccess") as PagePermissions.Access;
	}

	static getPage(c: Context<any>) {
		return c.get("page") as DB.Models.Page;
	}

	/** A 403 response if the caller may not perform `action` on the current page, else null. */
	static deny(c: Context<any>, action: PagePermissions.Action) {
		const access = this.getAccess(c);
		if (PagePermissions.can(access, action)) {
			return null;
		}

		switch (action) {
			case "manage_exclusives":
				return APIResponse.forbidden(
					c,
					access.category === "community"
						? "Community pages can't have exclusive products, redeem codes or grants"
						: "You are not allowed to manage redeem codes and grants of this page",
				);
			case "manage_members":
				return APIResponse.forbidden(
					c,
					access.category === "community"
						? "Community pages have a single owner"
						: "Only page owners and admins can manage members",
				);
			case "delete_page":
				return APIResponse.forbidden(c, "Only admins can delete official and partner pages");
			default:
				return APIResponse.forbidden(c, "You are not allowed to manage this page");
		}
	}

	/** Whether the caller acts on the page without being a member (admin intervention). */
	static isStaffIntervention(c: Context<any>) {
		return this.getAccess(c).member_role === null;
	}

	/**
	 * Studio actions go to the audit log on shared pages (official, partner) and whenever an admin
	 * acts on a page they are not a member of. A creator editing their own community page is not
	 * logged — the moderation review covers that content.
	 */
	static shouldAudit(c: Context<any>) {
		return this.getAccess(c).category !== "community" || this.isStaffIntervention(c);
	}
}
