import { and, asc, eq, inArray, isNotNull, isNull, like, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { CommunityReview } from "../../../../../utils/communityReview";
import { PagePermissions } from "../../../../../utils/permissions";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { ModerationPagesModel } from "./model";

async function pageViews(pages: DB.Models.Page[]): Promise<ModerationPagesModel.ModeratedPage[]> {
	const owners = pages.length
		? await DB.instance()
				.select({ page_id: DB.Tables.pageMembers.page_id, user: DB.Tables.users })
				.from(DB.Tables.pageMembers)
				.innerJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.pageMembers.user_id))
				.where(
					and(
						inArray(
							DB.Tables.pageMembers.page_id,
							pages.map((page) => page.id),
						),
						eq(DB.Tables.pageMembers.role, "owner"),
					),
				)
				.all()
		: [];

	const collections = await CommunityReview.loadCollectionsToReview(
		pages.filter((page) => page.category === "community").map((page) => page.id),
	);

	return pages.map((page) => ({
		...CatalogViews.page(page),
		status: page.status,
		status_note: page.status_note,
		owners: owners
			.filter((row) => row.page_id === page.id)
			.map((row) => CatalogViews.publicUser(row.user)),
		reviewed_at: page.reviewed_at,
		review_requested_at: page.review_requested_at,
		pending_changes: page.pending_changes ?? null,
		review_note: page.review_note,
		collections_to_review: (collections.get(page.id) ?? []).map((collection) => ({
			...CatalogViews.collection(collection),
			reviewed_at: collection.reviewed_at,
			pending_changes: collection.pending_changes ?? null,
		})),
		updated_at: page.updated_at,
	}));
}

type Variables = { page: DB.Models.Page };

export const router = new Hono<{ Variables: Variables }>().basePath("/pages");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List pages for moderation",
		description:
			"Pages of every category and status with their owners. `needs_review=true` lists the community pages whose profile (name, slug, description, icon, banner, collections) waits for a moderator.",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Pages retrieved successfully", ModerationPagesModel.GetAll.Response),
		),
	}),

	zValidator("query", ModerationPagesModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as ModerationPagesModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [];
		if (query.status) conditions.push(eq(DB.Tables.pages.status, query.status));
		if (query.category) conditions.push(eq(DB.Tables.pages.category, query.category));
		if (query.search) conditions.push(like(DB.Tables.pages.name, `%${query.search}%`));
		if (query.needs_review === true) {
			conditions.push(isNotNull(DB.Tables.pages.review_requested_at));
		} else if (query.needs_review === false) {
			conditions.push(isNull(DB.Tables.pages.review_requested_at));
		}

		const pages = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(and(...conditions))
			.orderBy(
				...(query.needs_review
					? [asc(DB.Tables.pages.review_requested_at)]
					: [asc(DB.Tables.pages.category), asc(DB.Tables.pages.name)]),
			)
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(c, "Pages retrieved successfully", await pageViews(pages));
	},
);

router.use(
	"/:pageId/*",

	zValidator("param", ModerationPagesModel.PageId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { pageId } = c.req.valid("param") as ModerationPagesModel.PageId.Params;

		const page = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(eq(DB.Tables.pages.id, pageId))
			.get();
		if (!page) {
			return APIResponse.notFound(c, "Page not found");
		}

		c.set("page", page);

		await next();
	},
);

/** Moderators don't review pages they are a member of (admins may). */
async function isOwnPage(c: Context<{ Variables: Variables }>) {
	const authContext = AuthHandler.AuthContext.getAsUser(c);
	if (authContext.user_role === "admin") return false;
	return (await PagePermissions.getMemberRole(c.get("page").id, authContext.user_id)) !== null;
}

router.get(
	"/:pageId",

	APIRouteSpec.authenticated({
		summary: "Get page for moderation",
		description:
			"A page with owners, moderation status and — for community pages — the profile changes and collections waiting for review.",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page retrieved successfully", ModerationPagesModel.ModeratedPage),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		const [view] = await pageViews([c.get("page")]);
		return APIResponse.success(
			c,
			"Page retrieved successfully",
			view as ModerationPagesModel.ModeratedPage,
		);
	},
);

router.post(
	"/:pageId/approve",

	APIRouteSpec.authenticated({
		summary: "Approve page profile",
		description:
			"Publish a community page's profile — its pending changes (name, slug, description, icon, banner) and new or changed collections. A community page and its products are public only after its profile was approved once. Send the `updated_at` you reviewed; 409 if the page changed since.",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page profile approved", ModerationPagesModel.ModeratedPage),
			APIResponseSpec.forbidden("You can't review your own content"),
			APIResponseSpec.notFound("Page not found"),
			APIResponseSpec.conflict(
				"Only community pages are reviewed / The page changed since you reviewed it / Slug taken",
			),
		),
	}),

	zValidator("json", ModerationPagesModel.Approve.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const { updated_at } = c.req.valid("json");

		if (page.category !== "community") {
			return APIResponse.conflict(c, "Only community pages are reviewed");
		}
		if (await isOwnPage(c)) {
			return APIResponse.forbidden(c, "You can't review your own content");
		}
		if (page.updated_at !== updated_at) {
			return APIResponse.conflict(c, "The page changed since you reviewed it");
		}

		const result = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const result = await CommunityReview.approve(page, tx);
			if (result.ok) {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "page.approve_changes",
						target_type: "page",
						target_id: page.id,
						details: { changes: page.pending_changes ?? {} },
					},
					tx,
				);
			}
			return result;
		});

		if (!result.ok) {
			return APIResponse.conflict(c, result.message);
		}

		const [view] = await pageViews([result.page]);
		return APIResponse.success(
			c,
			"Page profile approved",
			view as ModerationPagesModel.ModeratedPage,
		);
	},
);

router.post(
	"/:pageId/reject",

	APIRouteSpec.authenticated({
		summary: "Reject page profile changes",
		description:
			"Discard the pending profile and collection changes of a community page. The reason is shown to the owner; the approved values stay public (a never approved page stays hidden).",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page profile changes rejected", ModerationPagesModel.ModeratedPage),
			APIResponseSpec.forbidden("You can't review your own content"),
			APIResponseSpec.notFound("Page not found"),
			APIResponseSpec.conflict("Only community pages are reviewed"),
		),
	}),

	zValidator("json", ModerationPagesModel.Reject.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const { reason } = c.req.valid("json");

		if (page.category !== "community") {
			return APIResponse.conflict(c, "Only community pages are reviewed");
		}
		if (await isOwnPage(c)) {
			return APIResponse.forbidden(c, "You can't review your own content");
		}

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const updated = await CommunityReview.reject(page, reason, tx);
			await AuditLog.record(
				{
					actor_user_id: authContext.user_id,
					action: "page.reject_changes",
					target_type: "page",
					target_id: page.id,
					details: { reason },
				},
				tx,
			);
			return updated;
		});

		const [view] = await pageViews([updated]);
		return APIResponse.success(
			c,
			"Page profile changes rejected",
			view as ModerationPagesModel.ModeratedPage,
		);
	},
);

async function setStatus(
	page: DB.Models.Page,
	actorID: number,
	status: DB.Models.Page["status"],
	note: string | null,
) {
	return await DB.instance().transaction(async (tx: DrizzleDB) => {
		const updated = await tx
			.update(DB.Tables.pages)
			.set({ status, status_note: note, updated_at: Date.now() })
			.where(eq(DB.Tables.pages.id, page.id))
			.returning()
			.get();

		await AuditLog.record(
			{
				actor_user_id: actorID,
				action: status === "hidden" ? "page.hide" : "page.unhide",
				target_type: "page",
				target_id: page.id,
				details: note ? { reason: note } : {},
			},
			tx,
		);

		return updated;
	});
}

router.post(
	"/:pageId/hide",

	APIRouteSpec.authenticated({
		summary: "Hide page",
		description:
			"Hide a page and everything on it from the shop and from players in-game. Its members can still edit it.",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page hidden", ModerationPagesModel.ModeratedPage),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("json", ModerationPagesModel.Hide.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const { reason } = c.req.valid("json");

		const updated = await setStatus(c.get("page"), authContext.user_id, "hidden", reason);

		const [view] = await pageViews([updated]);
		return APIResponse.success(c, "Page hidden", view as ModerationPagesModel.ModeratedPage);
	},
);

router.post(
	"/:pageId/unhide",

	APIRouteSpec.authenticated({
		summary: "Unhide page",
		description: "Make a hidden page visible again.",
		tags: [DOCS_TAGS.MODERATION.PAGES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page restored", ModerationPagesModel.ModeratedPage),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);

		const updated = await setStatus(c.get("page"), authContext.user_id, "active", null);

		const [view] = await pageViews([updated]);
		return APIResponse.success(c, "Page restored", view as ModerationPagesModel.ModeratedPage);
	},
);
