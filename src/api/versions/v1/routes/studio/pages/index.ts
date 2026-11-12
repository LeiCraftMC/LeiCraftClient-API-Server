import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AssetStore } from "../../../../../utils/assets";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { CommunityReview } from "../../../../../utils/communityReview";
import { PagePermissions } from "../../../../../utils/permissions";
import type { CatalogSettings } from "../../../../../utils/shared-models/catalogData";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { UserHandler } from "../../../../../utils/users";
import { DOCS_TAGS } from "../../../docs";
import { StudioPageContext, type StudioPageEnv } from "./context";
import { StudioPagesModel } from "./model";

function studioPage(
	page: DB.Models.Page,
	memberRole: CatalogSettings.PageMemberRole | null,
): StudioPagesModel.StudioPage {
	return {
		...CatalogViews.page(page),
		status: page.status,
		status_note: page.status_note,
		member_role: memberRole,
		reviewed_at: page.reviewed_at,
		review_requested_at: page.review_requested_at,
		pending_changes: page.pending_changes ?? null,
		review_note: page.review_note,
		updated_at: page.updated_at,
	};
}

async function isSlugTaken(
	category: CatalogSettings.Category,
	slug: string,
	exceptPageID?: number,
) {
	const existing = await DB.instance()
		.select({ id: DB.Tables.pages.id })
		.from(DB.Tables.pages)
		.where(
			and(
				eq(DB.Tables.pages.category, category),
				eq(DB.Tables.pages.slug, slug),
				exceptPageID ? ne(DB.Tables.pages.id, exceptPageID) : undefined,
			),
		)
		.get();
	return !!existing;
}

export const router = new Hono<StudioPageEnv>().basePath("/pages");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List my pages",
		description:
			"Pages the caller may manage: pages they are a member of (their community page, partner pages they belong to). Admins get every page.",
		tags: [DOCS_TAGS.STUDIO.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Pages retrieved successfully", StudioPagesModel.GetAll.Response),
		),
	}),

	zValidator("query", StudioPagesModel.GetAll.Query),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const { category } = c.req.valid("query");

		const memberships = await DB.instance()
			.select()
			.from(DB.Tables.pageMembers)
			.where(eq(DB.Tables.pageMembers.user_id, authContext.user_id))
			.all();
		const roles = new Map(memberships.map((member) => [member.page_id, member.role]));

		const isAdmin = authContext.user_role === "admin";
		if (!isAdmin && roles.size === 0) {
			return APIResponse.success(c, "Pages retrieved successfully", []);
		}

		const pages = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(
				and(
					isAdmin ? undefined : inArray(DB.Tables.pages.id, [...roles.keys()]),
					category ? eq(DB.Tables.pages.category, category) : undefined,
				),
			)
			.orderBy(
				asc(DB.Tables.pages.category),
				asc(DB.Tables.pages.sort_order),
				asc(DB.Tables.pages.name),
			)
			.all();

		return APIResponse.success(
			c,
			"Pages retrieved successfully",
			pages.map((page) => studioPage(page, roles.get(page.id) ?? null)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create a page",
		description:
			"Users create their own `community` page (one per user) to upload capes and cosmetics. Admins create `partner` pages and the single `official` page (the LeiCraftClient team's shop — there is only one) and can assign an owner, who then manages the page and its members.",
		tags: [DOCS_TAGS.STUDIO.PAGES],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Page created successfully", StudioPagesModel.Create.Response),
			APIResponseSpec.badRequest("Syntax or validation error in request"),
			APIResponseSpec.forbidden("Only admins can create official and partner pages"),
			APIResponseSpec.notFound("Owner user not found"),
			APIResponseSpec.conflict(
				"Slug already in use / You already have a community page / There is already an official page",
			),
		),
	}),

	zValidator("json", StudioPagesModel.Create.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const body = c.req.valid("json");
		const isAdmin = authContext.user_role === "admin";

		if (!isAdmin) {
			if (body.category !== "community") {
				return APIResponse.forbidden(c, "Only admins can create official and partner pages");
			}
			if (body.owner_user_id !== undefined && body.owner_user_id !== authContext.user_id) {
				return APIResponse.forbidden(c, "Only admins can create pages for other users");
			}
		}

		const ownerID =
			body.owner_user_id ?? (body.category === "community" ? authContext.user_id : null);

		if (ownerID !== null && ownerID !== authContext.user_id) {
			const owner = await UserHandler.getByID(ownerID);
			if (!owner) {
				return APIResponse.notFound(c, "Owner user not found");
			}
		}

		if (body.category === "community" && ownerID !== null) {
			const existing = await DB.instance()
				.select({ id: DB.Tables.pages.id })
				.from(DB.Tables.pages)
				.innerJoin(DB.Tables.pageMembers, eq(DB.Tables.pageMembers.page_id, DB.Tables.pages.id))
				.where(
					and(
						eq(DB.Tables.pages.category, "community"),
						eq(DB.Tables.pageMembers.user_id, ownerID),
						eq(DB.Tables.pageMembers.role, "owner"),
					),
				)
				.get();
			if (existing) {
				return APIResponse.conflict(
					c,
					ownerID === authContext.user_id
						? "You already have a community page"
						: "This user already has a community page",
				);
			}
		}

		// The official category is a single page (the LeiCraftClient team's shop), not a list.
		if (body.category === "official") {
			const official = await DB.instance()
				.select({ id: DB.Tables.pages.id })
				.from(DB.Tables.pages)
				.where(eq(DB.Tables.pages.category, "official"))
				.get();
			if (official) {
				return APIResponse.conflict(c, "There is already an official page");
			}
		}

		if (await isSlugTaken(body.category, body.slug)) {
			return APIResponse.conflict(c, "Slug already in use");
		}

		const page = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const page = await tx
				.insert(DB.Tables.pages)
				.values({
					category: body.category,
					slug: body.slug,
					name: body.name,
					description: body.description ?? "",
					created_by_user_id: authContext.user_id,
					// a new community page waits for its first profile review
					review_requested_at: body.category === "community" ? Date.now() : null,
				})
				.returning()
				.get();

			if (ownerID !== null) {
				await tx.insert(DB.Tables.pageMembers).values({
					page_id: page.id,
					user_id: ownerID,
					role: "owner",
				});
			}

			if (body.category !== "community") {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "page.create",
						target_type: "page",
						target_id: page.id,
						details: { category: page.category, slug: page.slug, owner_user_id: ownerID },
					},
					tx,
				);
			}

			return page;
		});

		return APIResponse.created(
			c,
			"Page created successfully",
			studioPage(page, ownerID === authContext.user_id ? "owner" : null),
		);
	},
);

router.use(
	"/:pageId/*",

	zValidator("param", StudioPagesModel.PageId.Params),

	async (c, next) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);

		// @ts-ignore - hono-openapi does not type "param" yet
		const { pageId } = c.req.valid("param") as StudioPagesModel.PageId.Params;

		const page = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(eq(DB.Tables.pages.id, pageId))
			.get();

		const access: PagePermissions.Access | null = page
			? {
					user_role: authContext.user_role,
					member_role: await PagePermissions.getMemberRole(page.id, authContext.user_id),
					category: page.category,
				}
			: null;

		// Pages the caller can't manage look the same as missing ones.
		if (!page || !access || !PagePermissions.can(access, "view")) {
			return APIResponse.notFound(c, "Page not found");
		}

		c.set("page", page);
		c.set("pageAccess", access);

		await next();
	},
);

router.get(
	"/:pageId",

	APIRouteSpec.authenticated({
		summary: "Get page",
		description: "A page you manage, including its moderation status.",
		tags: [DOCS_TAGS.STUDIO.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page retrieved successfully", StudioPagesModel.StudioPage),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		return APIResponse.success(
			c,
			"Page retrieved successfully",
			studioPage(c.get("page"), c.get("pageAccess").member_role),
		);
	},
);

router.put(
	"/:pageId",

	APIRouteSpec.authenticated({
		summary: "Update page",
		description:
			"Change name, slug, description, icon or banner of a page. On a community page that was already reviewed, the changes wait in `pending_changes` for a moderator and the shop keeps the approved values. `sort_order` (position in the catalog) is admin-only. A hidden page stays hidden until a moderator restores it.",
		tags: [DOCS_TAGS.STUDIO.PAGES],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Page updated successfully", StudioPagesModel.Update.Response),
			APIResponseSpec.badRequest("Invalid asset / Syntax or validation error in request"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Page not found"),
			APIResponseSpec.conflict("Slug already in use"),
		),
	}),

	zValidator("json", StudioPagesModel.Update.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "edit_page");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const body = c.req.valid("json");

		if (body.sort_order !== undefined && authContext.user_role !== "admin") {
			return APIResponse.forbidden(c, "Only admins can change the catalog order of pages");
		}

		if (
			body.slug &&
			body.slug !== page.slug &&
			(await isSlugTaken(page.category, body.slug, page.id))
		) {
			return APIResponse.conflict(c, "Slug already in use");
		}

		const assetProblem = await AssetStore.checkReferences([
			{ field: "icon_asset_id", assetID: body.icon_asset_id, kind: "image" },
			{ field: "banner_asset_id", assetID: body.banner_asset_id, kind: "image" },
		]);
		if (assetProblem) {
			return APIResponse.badRequest(c, assetProblem);
		}

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			if (CommunityReview.appliesTo(page, authContext.user_role)) {
				// The catalog keeps the approved profile until a moderator approves the changes.
				const { sort_order: _sortOrder, ...changes } = body;
				await CommunityReview.submitPageChanges(page, changes, tx);
			} else {
				await tx
					.update(DB.Tables.pages)
					.set({ ...body, updated_at: Date.now() })
					.where(eq(DB.Tables.pages.id, page.id));
			}

			return (await tx
				.select()
				.from(DB.Tables.pages)
				.where(eq(DB.Tables.pages.id, page.id))
				.get()) as DB.Models.Page;
		});

		if (StudioPageContext.shouldAudit(c)) {
			await AuditLog.record({
				actor_user_id: authContext.user_id,
				action: "page.update",
				target_type: "page",
				target_id: page.id,
				details: { changes: body },
			});
		}

		return APIResponse.success(
			c,
			"Page updated successfully",
			studioPage(updated, c.get("pageAccess").member_role),
		);
	},
);

router.delete(
	"/:pageId",

	APIRouteSpec.authenticated({
		summary: "Delete page",
		description:
			"Delete a page with all its collections, products, codes and grants. Community owners can delete their page; official and partner pages only admins.",
		tags: [DOCS_TAGS.STUDIO.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Page deleted successfully"),
			APIResponseSpec.forbidden("Only admins can delete official and partner pages"),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "delete_page");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx.delete(DB.Tables.pages).where(eq(DB.Tables.pages.id, page.id));

			if (StudioPageContext.shouldAudit(c)) {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "page.delete",
						target_type: "page",
						target_id: page.id,
						details: { category: page.category, slug: page.slug, name: page.name },
					},
					tx,
				);
			}
		});

		return APIResponse.successNoData(c, "Page deleted successfully");
	},
);

router.route("/", (await import("./members")).router);
router.route("/", (await import("./collections")).router);
router.route("/", (await import("./products")).router);
router.route("/", (await import("./codes")).router);
