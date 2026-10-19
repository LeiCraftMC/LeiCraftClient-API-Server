import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../db";
import { APIResponse } from "../../../../../../utils/api-res";
import { AuditLog } from "../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../utils/catalogViews";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../utils/specHelpers";
import { UserHandler } from "../../../../../../utils/users";
import { DOCS_TAGS } from "../../../../docs";
import { StudioPageContext, type StudioPageEnv } from "../context";
import { StudioMembersModel } from "./model";

function memberView(member: DB.Models.PageMember, user: DB.Models.User): StudioMembersModel.Member {
	return {
		user: CatalogViews.publicUser(user),
		discord_username: user.discord_username,
		role: member.role,
		created_at: member.created_at,
	};
}

/**
 * A non-admin can't demote or remove the last owner — the page would be left without anyone
 * who manages its members. Returns a 409 response or null.
 */
async function guardLastOwner(c: Context<StudioPageEnv>, userID: number) {
	if (AuthHandler.AuthContext.getAsUser(c).user_role === "admin") {
		return null;
	}

	const owners = await DB.instance()
		.select({ user_id: DB.Tables.pageMembers.user_id })
		.from(DB.Tables.pageMembers)
		.where(
			and(
				eq(DB.Tables.pageMembers.page_id, c.get("page").id),
				eq(DB.Tables.pageMembers.role, "owner"),
			),
		)
		.all();

	const isOwner = owners.some((owner) => owner.user_id === userID);
	return isOwner && owners.length <= 1
		? APIResponse.conflict(c, "A page needs at least one owner")
		: null;
}

export const router = new Hono<StudioPageEnv>().basePath("/:pageId/members");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List members",
		description: "Who may manage the page: owners (also manage members) and managers.",
		tags: [DOCS_TAGS.STUDIO.MEMBERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Members retrieved successfully", StudioMembersModel.GetAll.Response),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		const rows = await DB.instance()
			.select({ member: DB.Tables.pageMembers, user: DB.Tables.users })
			.from(DB.Tables.pageMembers)
			.innerJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.pageMembers.user_id))
			.where(eq(DB.Tables.pageMembers.page_id, c.get("page").id))
			.orderBy(asc(DB.Tables.pageMembers.created_at))
			.all();

		return APIResponse.success(
			c,
			"Members retrieved successfully",
			rows.map((row) => memberView(row.member, row.user)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Add member",
		description:
			"Add a user (by LeiCraft user id or Discord id — they must have logged in once) to an official or partner page.",
		tags: [DOCS_TAGS.STUDIO.MEMBERS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Member added successfully", StudioMembersModel.Add.Response),
			APIResponseSpec.badRequest("Syntax or validation error in request"),
			APIResponseSpec.forbidden("Only page owners and admins can manage members"),
			APIResponseSpec.notFound("Page or user not found"),
			APIResponseSpec.conflict("User is already a member"),
		),
	}),

	zValidator("json", StudioMembersModel.Add.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_members");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const body = c.req.valid("json");

		const user = await UserHandler.resolveTarget({
			user_id: body.user_id,
			discord_id: body.discord_id,
		});
		if (!user || user === "ambiguous") {
			return APIResponse.notFound(c, "User not found (they must log in once)");
		}

		const member = await DB.instance()
			.insert(DB.Tables.pageMembers)
			.values({ page_id: page.id, user_id: user.id, role: body.role })
			.onConflictDoNothing()
			.returning()
			.get();

		if (!member) {
			return APIResponse.conflict(c, "User is already a member");
		}

		await AuditLog.record({
			actor_user_id: authContext.user_id,
			action: "page.member_add",
			target_type: "page",
			target_id: page.id,
			details: { user_id: user.id, role: body.role },
		});

		return APIResponse.created(c, "Member added successfully", memberView(member, user));
	},
);

router.put(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Change member role",
		description: "Make a member an owner or a manager.",
		tags: [DOCS_TAGS.STUDIO.MEMBERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Member updated successfully", StudioMembersModel.Update.Response),
			APIResponseSpec.forbidden("Only page owners and admins can manage members"),
			APIResponseSpec.notFound("Member not found"),
		),
	}),

	zValidator("param", StudioMembersModel.MemberId.Params),
	zValidator("json", StudioMembersModel.Update.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_members");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const { userId } = c.req.valid("param");
		const { role } = c.req.valid("json");

		if (role !== "owner") {
			const lastOwner = await guardLastOwner(c, userId);
			if (lastOwner) return lastOwner;
		}

		const member = await DB.instance()
			.update(DB.Tables.pageMembers)
			.set({ role })
			.where(
				and(eq(DB.Tables.pageMembers.page_id, page.id), eq(DB.Tables.pageMembers.user_id, userId)),
			)
			.returning()
			.get();

		const user = member ? await UserHandler.getByID(userId) : undefined;
		if (!member || !user) {
			return APIResponse.notFound(c, "Member not found");
		}

		await AuditLog.record({
			actor_user_id: authContext.user_id,
			action: "page.member_update",
			target_type: "page",
			target_id: page.id,
			details: { user_id: userId, role },
		});

		return APIResponse.success(c, "Member updated successfully", memberView(member, user));
	},
);

router.delete(
	"/:userId",

	APIRouteSpec.authenticated({
		summary: "Remove member",
		description: "Remove a member from the page.",
		tags: [DOCS_TAGS.STUDIO.MEMBERS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Member removed successfully"),
			APIResponseSpec.forbidden("Only page owners and admins can manage members"),
			APIResponseSpec.notFound("Member not found"),
		),
	}),

	zValidator("param", StudioMembersModel.MemberId.Params),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_members");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const { userId } = c.req.valid("param");

		const lastOwner = await guardLastOwner(c, userId);
		if (lastOwner) return lastOwner;

		const removed = await DB.instance()
			.delete(DB.Tables.pageMembers)
			.where(
				and(eq(DB.Tables.pageMembers.page_id, page.id), eq(DB.Tables.pageMembers.user_id, userId)),
			)
			.returning()
			.get();

		if (!removed) {
			return APIResponse.notFound(c, "Member not found");
		}

		await AuditLog.record({
			actor_user_id: authContext.user_id,
			action: "page.member_remove",
			target_type: "page",
			target_id: page.id,
			details: { user_id: userId },
		});

		return APIResponse.successNoData(c, "Member removed successfully");
	},
);
