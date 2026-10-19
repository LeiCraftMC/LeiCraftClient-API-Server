import { and, asc, count, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../../db";
import { type DrizzleDB } from "../../../../../../../../db/utils";
import { APIResponse } from "../../../../../../../utils/api-res";
import { AssetStore } from "../../../../../../../utils/assets";
import { AuditLog } from "../../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../../utils/catalogViews";
import { ProductLifecycle } from "../../../../../../../utils/products";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../../../docs";
import { StudioPageContext } from "../../context";
import type { StudioProductVariables } from "..";
import { StudioProductsModel } from "../model";

type Variables = StudioProductVariables & { variant: DB.Models.ProductVariant };

export const router = new Hono<{ Variables: Variables }>().basePath("/:productId/variants");

// Variants exist only on cosmetics, and a taken-down product's content is frozen.
router.use("*", async (c, next) => {
	const product = c.get("product");
	if (product.type !== "cosmetic") {
		return APIResponse.badRequest(c, "Only cosmetics have variants");
	}
	if (c.req.method !== "GET" && product.status === "disabled") {
		return APIResponse.forbidden(c, "This product was taken down by a moderator");
	}
	await next();
});

async function auditVariant(
	c: Context<any>,
	action: "variant.create" | "variant.update" | "variant.delete",
	productID: number,
	details: Record<string, any>,
	tx: DrizzleDB,
) {
	if (!StudioPageContext.shouldAudit(c)) return;
	await AuditLog.record(
		{
			actor_user_id: AuthHandler.AuthContext.getAsUser(c).user_id,
			action,
			target_type: "product",
			target_id: productID,
			details,
		},
		tx,
	);
}

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List variants",
		description:
			"Model + texture pairs of a cosmetic, one per skin fit. Renderers pick the variant whose `skin_model` matches the wearer, then an `any` variant, then the first.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Variants retrieved successfully",
				StudioProductsModel.Variants.Response,
			),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	async (c) => {
		const variants = await DB.instance()
			.select()
			.from(DB.Tables.productVariants)
			.where(eq(DB.Tables.productVariants.product_id, c.get("product").id))
			.orderBy(asc(DB.Tables.productVariants.sort_order), asc(DB.Tables.productVariants.id))
			.all();

		return APIResponse.success(
			c,
			"Variants retrieved successfully",
			variants.map((variant) => CatalogViews.variant(variant)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Add variant",
		description: `Add a model + texture for a skin model (\`any\`, \`wide\` or \`slim\`). At most ${ProductLifecycle.MAX_VARIANTS} variants per cosmetic.`,
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created(
				"Variant created successfully",
				StudioProductsModel.CreateVariant.Response,
			),
			APIResponseSpec.badRequest(
				"Invalid asset / Too many variants / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	zValidator("json", StudioProductsModel.CreateVariant.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const product = c.get("product");
		const body = c.req.valid("json");

		const existing =
			(
				await DB.instance()
					.select({ value: count() })
					.from(DB.Tables.productVariants)
					.where(eq(DB.Tables.productVariants.product_id, product.id))
					.get()
			)?.value ?? 0;
		if (existing >= ProductLifecycle.MAX_VARIANTS) {
			return APIResponse.badRequest(
				c,
				`A cosmetic can have at most ${ProductLifecycle.MAX_VARIANTS} variants`,
			);
		}

		const assetProblem =
			(await AssetStore.checkReferences([
				{ field: "model_asset_id", assetID: body.model_asset_id, kind: "cosmetic_model" },
				{ field: "texture_asset_id", assetID: body.texture_asset_id, kind: "cosmetic_texture" },
			])) ??
			(await AssetStore.checkExclusiveUse(
				[
					{ field: "model_asset_id", assetID: body.model_asset_id },
					{ field: "texture_asset_id", assetID: body.texture_asset_id },
				],
				c.get("page").id,
			));
		if (assetProblem) {
			return APIResponse.badRequest(c, assetProblem);
		}

		const variant = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const variant = await tx
				.insert(DB.Tables.productVariants)
				.values({
					product_id: product.id,
					name: body.name,
					skin_model: body.skin_model ?? "any",
					model_asset_id: body.model_asset_id,
					texture_asset_id: body.texture_asset_id,
					sort_order: body.sort_order ?? existing,
				})
				.returning()
				.get();

			await ProductLifecycle.onContentChanged(product.id, c.get("page").category, tx);
			await auditVariant(c, "variant.create", product.id, { variant_id: variant.id }, tx);

			return variant;
		});

		return APIResponse.created(c, "Variant created successfully", CatalogViews.variant(variant));
	},
);

router.use(
	"/:variantId/*",

	zValidator("param", StudioProductsModel.VariantId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { variantId } = c.req.valid("param") as StudioProductsModel.VariantId.Params;

		const variant = await DB.instance()
			.select()
			.from(DB.Tables.productVariants)
			.where(
				and(
					eq(DB.Tables.productVariants.id, variantId),
					eq(DB.Tables.productVariants.product_id, c.get("product").id),
				),
			)
			.get();

		if (!variant) {
			return APIResponse.notFound(c, "Variant not found");
		}

		c.set("variant", variant);

		await next();
	},
);

router.put(
	"/:variantId",

	APIRouteSpec.authenticated({
		summary: "Update variant",
		description: "Change name, skin model, model, texture or order of a variant.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Variant updated successfully",
				StudioProductsModel.UpdateVariant.Response,
			),
			APIResponseSpec.badRequest("Invalid asset / Syntax or validation error in request"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Variant not found"),
		),
	}),

	zValidator("json", StudioProductsModel.UpdateVariant.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const variant = c.get("variant");
		const body = c.req.valid("json");

		const assetProblem =
			(await AssetStore.checkReferences([
				{ field: "model_asset_id", assetID: body.model_asset_id, kind: "cosmetic_model" },
				{ field: "texture_asset_id", assetID: body.texture_asset_id, kind: "cosmetic_texture" },
			])) ??
			(await AssetStore.checkExclusiveUse(
				[
					{ field: "model_asset_id", assetID: body.model_asset_id },
					{ field: "texture_asset_id", assetID: body.texture_asset_id },
				],
				c.get("page").id,
			));
		if (assetProblem) {
			return APIResponse.badRequest(c, assetProblem);
		}

		const updated = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const updated = await tx
				.update(DB.Tables.productVariants)
				.set({ ...body, updated_at: Date.now() })
				.where(eq(DB.Tables.productVariants.id, variant.id))
				.returning()
				.get();

			await ProductLifecycle.onContentChanged(variant.product_id, c.get("page").category, tx);
			await auditVariant(
				c,
				"variant.update",
				variant.product_id,
				{ variant_id: variant.id, changes: body },
				tx,
			);

			return updated;
		});

		return APIResponse.success(c, "Variant updated successfully", CatalogViews.variant(updated));
	},
);

router.delete(
	"/:variantId",

	APIRouteSpec.authenticated({
		summary: "Delete variant",
		description:
			"Delete a variant. The last variant of a published or waiting cosmetic can't be deleted — unpublish it first.",
		tags: [DOCS_TAGS.STUDIO.PRODUCTS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Variant deleted successfully"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Variant not found"),
			APIResponseSpec.conflict("A published cosmetic needs at least one variant"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const product = c.get("product");
		const variant = c.get("variant");

		const remaining =
			(
				await DB.instance()
					.select({ value: count() })
					.from(DB.Tables.productVariants)
					.where(eq(DB.Tables.productVariants.product_id, product.id))
					.get()
			)?.value ?? 0;

		if (remaining <= 1 && (product.status === "published" || product.status === "pending_review")) {
			return APIResponse.conflict(c, "A published cosmetic needs at least one variant");
		}

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx.delete(DB.Tables.productVariants).where(eq(DB.Tables.productVariants.id, variant.id));
			await ProductLifecycle.onContentChanged(product.id, c.get("page").category, tx);
			await auditVariant(c, "variant.delete", product.id, { variant_id: variant.id }, tx);
		});

		return APIResponse.successNoData(c, "Variant deleted successfully");
	},
);
