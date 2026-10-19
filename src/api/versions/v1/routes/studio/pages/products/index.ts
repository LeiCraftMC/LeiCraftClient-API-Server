import { and, asc, desc, eq, like, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../db";
import { type DrizzleDB } from "../../../../../../../db/utils";
import { APIResponse } from "../../../../../../utils/api-res";
import { AssetStore } from "../../../../../../utils/assets";
import { AuditLog } from "../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../utils/catalogViews";
import { PagePermissions } from "../../../../../../utils/permissions";
import { ProductLifecycle } from "../../../../../../utils/products";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../../docs";
import { StudioPageContext, type StudioPageVariables } from "../context";
import { StudioProductsModel } from "./model";

export type StudioProductVariables = StudioPageVariables & { product: DB.Models.Product };

async function getCollectionProblem(pageID: number, collectionID: number | null | undefined) {
	if (collectionID === null || collectionID === undefined) {
		return null;
	}
	const collection = await DB.instance()
		.select({ page_id: DB.Tables.collections.page_id })
		.from(DB.Tables.collections)
		.where(eq(DB.Tables.collections.id, collectionID))
		.get();
	return collection?.page_id === pageID ? null : "collection_id: collection not found on this page";
}

export const router = new Hono<{ Variables: StudioProductVariables }>().basePath(
	"/:pageId/products",
);

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List products",
		description: "All products of the page in every status, with review notes.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Products retrieved successfully", StudioProductsModel.GetAll.Response),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("query", StudioProductsModel.GetAll.Query),

	async (c) => {
		const page = c.get("page");
		const query = c.req.valid("query") as StudioProductsModel.GetAll.Query;

		const conditions: Array<SQL | undefined> = [eq(DB.Tables.products.page_id, page.id)];
		if (query.status) conditions.push(eq(DB.Tables.products.status, query.status));
		if (query.type) conditions.push(eq(DB.Tables.products.type, query.type));
		if (query.collection_id)
			conditions.push(eq(DB.Tables.products.collection_id, query.collection_id));
		if (query.search) conditions.push(like(DB.Tables.products.name, `%${query.search}%`));

		const rows = await DB.instance()
			.select()
			.from(DB.Tables.products)
			.where(and(...conditions))
			.orderBy(asc(DB.Tables.products.sort_order), desc(DB.Tables.products.created_at))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(
			c,
			"Products retrieved successfully",
			await CatalogViews.managedProducts(rows),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create product",
		description:
			"Create a cape or cosmetic as `draft`. Capes take a `cape_texture` asset; cosmetics get their model and texture through variants. Publish it with `POST …/publish`.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Product created successfully", StudioProductsModel.Create.Response),
			APIResponseSpec.badRequest(
				"Invalid asset or collection / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden(
				"You are not allowed to manage this page / Exclusive products are not available on this page",
			),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("json", StudioProductsModel.Create.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const body = c.req.valid("json");

		if (
			body.availability === "exclusive" &&
			!PagePermissions.can(c.get("pageAccess"), "manage_exclusives")
		) {
			return APIResponse.forbidden(c, "Exclusive products are not available on this page");
		}

		if (body.type === "cosmetic" && body.texture_asset_id) {
			return APIResponse.badRequest(
				c,
				"texture_asset_id: cosmetics get their model and texture through variants",
			);
		}

		const problem =
			(await getCollectionProblem(page.id, body.collection_id)) ??
			(await AssetStore.checkReferences([
				{ field: "texture_asset_id", assetID: body.texture_asset_id, kind: "cape_texture" },
				{ field: "preview_asset_id", assetID: body.preview_asset_id, kind: "image" },
			])) ??
			(await AssetStore.checkExclusiveUse(
				[{ field: "texture_asset_id", assetID: body.texture_asset_id }],
				page.id,
			));
		if (problem) {
			return APIResponse.badRequest(c, problem);
		}

		const product = await DB.instance()
			.insert(DB.Tables.products)
			.values({
				page_id: page.id,
				type: body.type,
				name: body.name,
				description: body.description ?? "",
				collection_id: body.collection_id ?? null,
				availability: body.availability ?? "free",
				listed: body.listed ?? true,
				texture_asset_id: body.texture_asset_id ?? null,
				preview_asset_id: body.preview_asset_id ?? null,
				sort_order: body.sort_order ?? 0,
				creator_user_id: authContext.user_id,
			})
			.returning()
			.get();

		if (StudioPageContext.shouldAudit(c)) {
			await AuditLog.record({
				actor_user_id: authContext.user_id,
				action: "product.create",
				target_type: "product",
				target_id: product.id,
				details: { page_id: page.id, type: product.type, name: product.name },
			});
		}

		return APIResponse.created(
			c,
			"Product created successfully",
			await CatalogViews.managedProduct(product),
		);
	},
);

router.use(
	"/:productId/*",

	zValidator("param", StudioProductsModel.ProductId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { productId } = c.req.valid("param") as StudioProductsModel.ProductId.Params;

		const product = await DB.instance()
			.select()
			.from(DB.Tables.products)
			.where(
				and(eq(DB.Tables.products.id, productId), eq(DB.Tables.products.page_id, c.get("page").id)),
			)
			.get();

		if (!product) {
			return APIResponse.notFound(c, "Product not found");
		}

		c.set("product", product);

		await next();
	},
);

router.get(
	"/:productId",

	APIRouteSpec.authenticated({
		summary: "Get product",
		description: "One product of the page with status and review note.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product retrieved successfully", StudioProductsModel.Create.Response),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		return APIResponse.success(
			c,
			"Product retrieved successfully",
			await CatalogViews.managedProduct(c.get("product")),
		);
	},
);

router.put(
	"/:productId",

	APIRouteSpec.authenticated({
		summary: "Update product",
		description:
			"Change a product. On community pages, changing name, description, texture or preview of a published or waiting product sends it back to the review queue.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success("Product updated successfully", StudioProductsModel.Update.Response),
			APIResponseSpec.badRequest(
				"Invalid asset or collection / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden(
				"You are not allowed to manage this page / Exclusive products are not available on this page",
			),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	zValidator("json", StudioProductsModel.Update.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const product = c.get("product");
		const body = c.req.valid("json");

		// A takedown freezes the content: restoring must not publish anything nobody reviewed.
		if (product.status === "disabled") {
			return APIResponse.forbidden(c, "This product was taken down by a moderator");
		}

		if (
			body.availability === "exclusive" &&
			!PagePermissions.can(c.get("pageAccess"), "manage_exclusives")
		) {
			return APIResponse.forbidden(c, "Exclusive products are not available on this page");
		}

		if (product.type === "cosmetic" && body.texture_asset_id) {
			return APIResponse.badRequest(
				c,
				"texture_asset_id: cosmetics get their model and texture through variants",
			);
		}

		if (
			product.type === "cape" &&
			body.texture_asset_id === null &&
			(product.status === "published" || product.status === "pending_review")
		) {
			return APIResponse.badRequest(
				c,
				"texture_asset_id: a published cape needs a texture — unpublish it first",
			);
		}

		const problem =
			(await getCollectionProblem(page.id, body.collection_id)) ??
			(await AssetStore.checkReferences([
				{ field: "texture_asset_id", assetID: body.texture_asset_id, kind: "cape_texture" },
				{ field: "preview_asset_id", assetID: body.preview_asset_id, kind: "image" },
			])) ??
			(await AssetStore.checkExclusiveUse(
				[{ field: "texture_asset_id", assetID: body.texture_asset_id }],
				page.id,
			));
		if (problem) {
			return APIResponse.badRequest(c, problem);
		}

		const contentChanged = ProductLifecycle.REVIEWED_FIELDS.some(
			(field) => body[field] !== undefined && body[field] !== product[field],
		);

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx
				.update(DB.Tables.products)
				.set({ ...body, updated_at: Date.now() })
				.where(eq(DB.Tables.products.id, product.id));

			if (contentChanged) {
				await ProductLifecycle.onContentChanged(product.id, page.category, tx);
			}

			if (StudioPageContext.shouldAudit(c)) {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "product.update",
						target_type: "product",
						target_id: product.id,
						details: { changes: body },
					},
					tx,
				);
			}

			return (await tx
				.select()
				.from(DB.Tables.products)
				.where(eq(DB.Tables.products.id, product.id))
				.get()) as DB.Models.Product;
		});

		return APIResponse.success(
			c,
			"Product updated successfully",
			await CatalogViews.managedProduct(updated),
		);
	},
);

router.delete(
	"/:productId",

	APIRouteSpec.authenticated({
		summary: "Delete product",
		description: "Delete a product. It disappears from every loadout, inventory and redeem code.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Product deleted successfully"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const product = c.get("product");

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx.delete(DB.Tables.products).where(eq(DB.Tables.products.id, product.id));

			if (StudioPageContext.shouldAudit(c)) {
				await AuditLog.record(
					{
						actor_user_id: authContext.user_id,
						action: "product.delete",
						target_type: "product",
						target_id: product.id,
						details: { page_id: product.page_id, name: product.name, type: product.type },
					},
					tx,
				);
			}
		});

		return APIResponse.successNoData(c, "Product deleted successfully");
	},
);

router.post(
	"/:productId/publish",

	APIRouteSpec.authenticated({
		summary: "Publish product",
		description:
			"Official and partner products go live immediately. Community products are submitted to the moderators (`pending_review`). A cape needs a texture, a cosmetic at least one variant.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Product status updated successfully",
				StudioProductsModel.Create.Response,
			),
			APIResponseSpec.forbidden("This product was taken down by a moderator"),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const result = await ProductLifecycle.publish(c.get("product"), c.get("page").category);
		if (!result.ok) {
			return result.code === 403
				? APIResponse.forbidden(c, result.message)
				: APIResponse.badRequest(c, result.message);
		}

		if (StudioPageContext.shouldAudit(c)) {
			await AuditLog.record({
				actor_user_id: AuthHandler.AuthContext.getAsUser(c).user_id,
				action: "product.publish",
				target_type: "product",
				target_id: result.product.id,
				details: { status: result.product.status },
			});
		}

		return APIResponse.success(
			c,
			"Product status updated successfully",
			await CatalogViews.managedProduct(result.product),
		);
	},
);

router.post(
	"/:productId/unpublish",

	APIRouteSpec.authenticated({
		summary: "Unpublish product",
		description: "Take a product offline (back to `draft`) or withdraw it from the review queue.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Product status updated successfully",
				StudioProductsModel.Create.Response,
			),
			APIResponseSpec.forbidden("This product was taken down by a moderator"),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const result = await ProductLifecycle.unpublish(c.get("product"));
		if (!result.ok) {
			return APIResponse.forbidden(c, result.message);
		}

		if (StudioPageContext.shouldAudit(c)) {
			await AuditLog.record({
				actor_user_id: AuthHandler.AuthContext.getAsUser(c).user_id,
				action: "product.unpublish",
				target_type: "product",
				target_id: result.product.id,
			});
		}

		return APIResponse.success(
			c,
			"Product status updated successfully",
			await CatalogViews.managedProduct(result.product),
		);
	},
);

router.route("/", (await import("./variants")).router);
router.route("/", (await import("./owners")).router);
