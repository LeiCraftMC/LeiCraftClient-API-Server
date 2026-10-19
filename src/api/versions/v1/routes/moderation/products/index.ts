import { and, asc, eq, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { type DrizzleDB } from "../../../../../../db/utils";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../utils/catalogViews";
import { PagePermissions } from "../../../../../utils/permissions";
import { ProductLifecycle } from "../../../../../utils/products";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { ModerationProductsModel } from "./model";

type Variables = { product: DB.Models.Product; page: DB.Models.Page };

async function entries(
	rows: Array<{ product: DB.Models.Product; page: DB.Models.Page }>,
): Promise<ModerationProductsModel.Entry[]> {
	const products = await CatalogViews.managedProducts(rows.map((row) => row.product));
	return rows.map((row, index) => ({
		product: products[index] as ModerationProductsModel.Entry["product"],
		page: { ...CatalogViews.page(row.page), status: row.page.status },
	}));
}

export const router = new Hono<{ Variables: Variables }>().basePath("/products");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List products for moderation",
		description:
			"Products by status — by default the review queue (`pending_review`, oldest first). Includes products of every category.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Products retrieved successfully",
				ModerationProductsModel.GetAll.Response,
			),
		),
	}),

	zValidator("query", ModerationProductsModel.GetAll.Query),

	async (c) => {
		const query = c.req.valid("query") as ModerationProductsModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [eq(DB.Tables.products.status, query.status)];
		if (query.category) conditions.push(eq(DB.Tables.pages.category, query.category));
		if (query.page_id) conditions.push(eq(DB.Tables.products.page_id, query.page_id));

		const rows = await DB.instance()
			.select({ product: DB.Tables.products, page: DB.Tables.pages })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(and(...conditions))
			.orderBy(asc(DB.Tables.products.updated_at))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(c, "Products retrieved successfully", await entries(rows));
	},
);

router.use(
	"/:productId/*",

	zValidator("param", ModerationProductsModel.ProductId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { productId } = c.req.valid("param") as ModerationProductsModel.ProductId.Params;

		const row = await DB.instance()
			.select({ product: DB.Tables.products, page: DB.Tables.pages })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(eq(DB.Tables.products.id, productId))
			.get();

		if (!row) {
			return APIResponse.notFound(c, "Product not found");
		}

		c.set("product", row.product);
		c.set("page", row.page);

		await next();
	},
);

async function review(
	productID: number,
	actorID: number,
	action: "product.approve" | "product.reject" | "product.disable" | "product.restore",
	changes: Partial<DB.Models.Product>,
	reason: string | null,
) {
	return await DB.instance().transaction(async (tx: DrizzleDB) => {
		const updated = await tx
			.update(DB.Tables.products)
			.set({
				...changes,
				review_note: reason,
				reviewed_by_user_id: actorID,
				reviewed_at: Date.now(),
				updated_at: Date.now(),
			})
			.where(eq(DB.Tables.products.id, productID))
			.returning()
			.get();

		await AuditLog.record(
			{
				actor_user_id: actorID,
				action,
				target_type: "product",
				target_id: productID,
				details: reason ? { reason } : {},
			},
			tx,
		);

		return updated;
	});
}

/** Moderators don't review content of pages they are a member of (admins may). */
async function isOwnContent(c: Context<{ Variables: Variables }>) {
	const authContext = AuthHandler.AuthContext.getAsUser(c);
	if (authContext.user_role === "admin") return false;
	return (await PagePermissions.getMemberRole(c.get("page").id, authContext.user_id)) !== null;
}

router.get(
	"/:productId",

	APIRouteSpec.authenticated({
		summary: "Get product for moderation",
		description: "A product in any status with its page.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product retrieved successfully", ModerationProductsModel.Entry),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		const [entry] = await entries([{ product: c.get("product"), page: c.get("page") }]);
		return APIResponse.success(
			c,
			"Product retrieved successfully",
			entry as ModerationProductsModel.Entry,
		);
	},
);

router.post(
	"/:productId/approve",

	APIRouteSpec.authenticated({
		summary: "Approve product",
		description:
			"Publish a product waiting for review. Send the `updated_at` of the version you reviewed: if the creator changed the product since, the approval fails with 409. Moderators can't review products of their own pages.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product approved", ModerationProductsModel.Entry),
			APIResponseSpec.forbidden("You can't review your own content"),
			APIResponseSpec.notFound("Product not found"),
			APIResponseSpec.conflict(
				"The product is not waiting for review / The product changed since you reviewed it",
			),
		),
	}),

	zValidator("json", ModerationProductsModel.Approve.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");
		const { updated_at } = c.req.valid("json");

		if (await isOwnContent(c)) {
			return APIResponse.forbidden(c, "You can't review your own content");
		}

		if (product.status !== "pending_review") {
			return APIResponse.conflict(c, "The product is not waiting for review");
		}

		if (product.updated_at !== updated_at) {
			return APIResponse.conflict(c, "The product changed since you reviewed it");
		}

		const problem = await ProductLifecycle.getCompletenessProblem(product);
		if (problem) {
			return APIResponse.conflict(c, problem);
		}

		const updated = await review(
			product.id,
			authContext.user_id,
			"product.approve",
			{ status: "published", published_at: product.published_at ?? Date.now() },
			null,
		);

		const [entry] = await entries([{ product: updated, page: c.get("page") }]);
		return APIResponse.success(c, "Product approved", entry as ModerationProductsModel.Entry);
	},
);

router.post(
	"/:productId/reject",

	APIRouteSpec.authenticated({
		summary: "Reject product",
		description:
			"Reject a product waiting for review. The reason is shown to the creator, who can fix and resubmit it.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product rejected", ModerationProductsModel.Entry),
			APIResponseSpec.forbidden("You can't review your own content"),
			APIResponseSpec.notFound("Product not found"),
			APIResponseSpec.conflict("The product is not waiting for review"),
		),
	}),

	zValidator("json", ModerationProductsModel.WithReason.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");
		const { reason } = c.req.valid("json");

		if (await isOwnContent(c)) {
			return APIResponse.forbidden(c, "You can't review your own content");
		}

		if (product.status !== "pending_review") {
			return APIResponse.conflict(c, "The product is not waiting for review");
		}

		const updated = await review(
			product.id,
			authContext.user_id,
			"product.reject",
			{ status: "rejected" },
			reason,
		);

		const [entry] = await entries([{ product: updated, page: c.get("page") }]);
		return APIResponse.success(c, "Product rejected", entry as ModerationProductsModel.Entry);
	},
);

router.post(
	"/:productId/disable",

	APIRouteSpec.authenticated({
		summary: "Take down product",
		description:
			"Disable a product in any category (e.g. after a report). It disappears from the shop and from every player in-game until restored; page members can't edit or republish it meanwhile.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product disabled", ModerationProductsModel.Entry),
			APIResponseSpec.notFound("Product not found"),
			APIResponseSpec.conflict("The product is already disabled"),
		),
	}),

	zValidator("json", ModerationProductsModel.WithReason.Body),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");
		const { reason } = c.req.valid("json");

		if (product.status === "disabled") {
			return APIResponse.conflict(c, "The product is already disabled");
		}

		const updated = await review(
			product.id,
			authContext.user_id,
			"product.disable",
			{ status: "disabled", status_before_disable: product.status },
			reason,
		);

		const [entry] = await entries([{ product: updated, page: c.get("page") }]);
		return APIResponse.success(c, "Product disabled", entry as ModerationProductsModel.Entry);
	},
);

router.post(
	"/:productId/restore",

	APIRouteSpec.authenticated({
		summary: "Restore product",
		description:
			"Return a disabled product to the status it had before the takedown (its content could not change meanwhile). Incomplete products go back to `draft`.",
		tags: [DOCS_TAGS.MODERATION.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product restored", ModerationProductsModel.Entry),
			APIResponseSpec.notFound("Product not found"),
			APIResponseSpec.conflict("The product is not disabled"),
		),
	}),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");

		if (product.status !== "disabled") {
			return APIResponse.conflict(c, "The product is not disabled");
		}

		const previous = product.status_before_disable ?? "draft";
		const isLive = previous === "published" || previous === "pending_review";
		const problem = isLive ? await ProductLifecycle.getCompletenessProblem(product) : null;
		const status = problem ? "draft" : previous;

		const updated = await review(
			product.id,
			authContext.user_id,
			"product.restore",
			{
				status,
				status_before_disable: null,
				...(status === "published" ? { published_at: product.published_at ?? Date.now() } : {}),
			},
			null,
		);

		const [entry] = await entries([{ product: updated, page: c.get("page") }]);
		return APIResponse.success(c, "Product restored", entry as ModerationProductsModel.Entry);
	},
);
