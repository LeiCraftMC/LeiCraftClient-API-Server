import { and, asc, count, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../../db";
import { type DrizzleDB } from "../../../../../../../db/utils";
import { APIResponse } from "../../../../../../utils/api-res";
import { AssetStore } from "../../../../../../utils/assets";
import { AuditLog } from "../../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../../utils/authHandler";
import { CatalogViews } from "../../../../../../utils/catalogViews";
import { CommunityReview } from "../../../../../../utils/communityReview";
import { APIResponseSpec, APIRouteSpec } from "../../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../../docs";
import { StudioPageContext, type StudioPageEnv } from "../context";
import { StudioCollectionsModel } from "./model";

function studioCollection(
	collection: DB.Models.Collection,
	productCount: number,
): StudioCollectionsModel.StudioCollection {
	return {
		...CatalogViews.collection(collection),
		product_count: productCount,
		reviewed_at: collection.reviewed_at,
		pending_changes: collection.pending_changes ?? null,
		updated_at: collection.updated_at,
	};
}

async function collectionView(collectionID: number, tx: DrizzleDB = DB.instance()) {
	const collection = (await tx
		.select()
		.from(DB.Tables.collections)
		.where(eq(DB.Tables.collections.id, collectionID))
		.get()) as DB.Models.Collection;

	const productCount =
		(
			await tx
				.select({ value: count() })
				.from(DB.Tables.products)
				.where(eq(DB.Tables.products.collection_id, collectionID))
				.get()
		)?.value ?? 0;

	return studioCollection(collection, productCount);
}

async function audit(
	c: Context<any>,
	action: "collection.create" | "collection.update" | "collection.delete",
	collectionID: number,
	details: Record<string, any>,
	tx: DrizzleDB,
) {
	if (!StudioPageContext.shouldAudit(c)) return;
	await AuditLog.record(
		{
			actor_user_id: AuthHandler.AuthContext.getAsUser(c).user_id,
			action,
			target_type: "collection",
			target_id: collectionID,
			details,
		},
		tx,
	);
}

type Variables = StudioPageEnv["Variables"] & { collection: DB.Models.Collection };

export const router = new Hono<{ Variables: Variables }>().basePath("/:pageId/collections");

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List collections",
		description: "All collections of the page with their product counts and review state.",
		tags: [DOCS_TAGS.STUDIO.COLLECTIONS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Collections retrieved successfully",
				StudioCollectionsModel.GetAll.Response,
			),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	async (c) => {
		const page = c.get("page");

		const rows = await DB.instance()
			.select({ collection: DB.Tables.collections, product_count: count(DB.Tables.products.id) })
			.from(DB.Tables.collections)
			.leftJoin(DB.Tables.products, eq(DB.Tables.products.collection_id, DB.Tables.collections.id))
			.where(eq(DB.Tables.collections.page_id, page.id))
			.groupBy(DB.Tables.collections.id)
			.orderBy(asc(DB.Tables.collections.sort_order), asc(DB.Tables.collections.name))
			.all();

		return APIResponse.success(
			c,
			"Collections retrieved successfully",
			rows.map((row) => studioCollection(row.collection, row.product_count)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Create collection",
		description:
			"Create a collection (a group of products, formerly called package) on the page. On community pages it becomes public with the next profile review.",
		tags: [DOCS_TAGS.STUDIO.COLLECTIONS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created(
				"Collection created successfully",
				StudioCollectionsModel.Create.Response,
			),
			APIResponseSpec.badRequest("Invalid asset / Syntax or validation error in request"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("json", StudioCollectionsModel.Create.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const body = c.req.valid("json");

		const assetProblem = await AssetStore.checkReferences([
			{ field: "preview_asset_id", assetID: body.preview_asset_id, kind: "image" },
		]);
		if (assetProblem) {
			return APIResponse.badRequest(c, assetProblem);
		}

		const view = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const collection = await tx
				.insert(DB.Tables.collections)
				.values({
					page_id: page.id,
					name: body.name,
					description: body.description ?? "",
					preview_asset_id: body.preview_asset_id ?? null,
					sort_order: body.sort_order ?? 0,
					// admins' collections on community pages need no review
					reviewed_at:
						page.category === "community" && authContext.user_role === "admin" ? Date.now() : null,
				})
				.returning()
				.get();

			if (CommunityReview.appliesTo(page, authContext.user_role)) {
				await CommunityReview.requestReview(page.id, tx);
			}
			await audit(c, "collection.create", collection.id, { name: collection.name }, tx);

			return await collectionView(collection.id, tx);
		});

		return APIResponse.created(c, "Collection created successfully", view);
	},
);

router.use(
	"/:collectionId/*",

	zValidator("param", StudioCollectionsModel.CollectionId.Params),

	async (c, next) => {
		// @ts-ignore - hono-openapi does not type "param" yet
		const { collectionId } = c.req.valid("param") as StudioCollectionsModel.CollectionId.Params;

		const collection = await DB.instance()
			.select()
			.from(DB.Tables.collections)
			.where(
				and(
					eq(DB.Tables.collections.id, collectionId),
					eq(DB.Tables.collections.page_id, c.get("page").id),
				),
			)
			.get();

		if (!collection) {
			return APIResponse.notFound(c, "Collection not found");
		}

		c.set("collection", collection);

		await next();
	},
);

router.get(
	"/:collectionId",

	APIRouteSpec.authenticated({
		summary: "Get collection",
		description: "One collection of the page.",
		tags: [DOCS_TAGS.STUDIO.COLLECTIONS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Collection retrieved successfully",
				StudioCollectionsModel.StudioCollection,
			),
			APIResponseSpec.notFound("Collection not found"),
		),
	}),

	async (c) => {
		return APIResponse.success(
			c,
			"Collection retrieved successfully",
			await collectionView(c.get("collection").id),
		);
	},
);

router.put(
	"/:collectionId",

	APIRouteSpec.authenticated({
		summary: "Update collection",
		description:
			"Change name, description, preview image or order of a collection. On community pages, changes to a reviewed collection wait in `pending_changes` for a moderator.",
		tags: [DOCS_TAGS.STUDIO.COLLECTIONS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Collection updated successfully",
				StudioCollectionsModel.Update.Response,
			),
			APIResponseSpec.badRequest("Invalid asset / Syntax or validation error in request"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Collection not found"),
		),
	}),

	zValidator("json", StudioCollectionsModel.Update.Body),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const authContext = AuthHandler.AuthContext.getAsUser(c);
		const page = c.get("page");
		const collection = c.get("collection");
		const body = c.req.valid("json");

		const assetProblem = await AssetStore.checkReferences([
			{ field: "preview_asset_id", assetID: body.preview_asset_id, kind: "image" },
		]);
		if (assetProblem) {
			return APIResponse.badRequest(c, assetProblem);
		}

		const view = await DB.instance().transaction(async (tx: DrizzleDB) => {
			const { sort_order, ...changes } = body;

			// The order is not shown content; it needs no review.
			if (sort_order !== undefined) {
				await tx
					.update(DB.Tables.collections)
					.set({ sort_order, updated_at: Date.now() })
					.where(eq(DB.Tables.collections.id, collection.id));
			}

			if (Object.values(changes).some((value) => value !== undefined)) {
				if (CommunityReview.appliesTo(page, authContext.user_role)) {
					await CommunityReview.submitCollectionChanges(collection, changes, tx);
				} else {
					await tx
						.update(DB.Tables.collections)
						.set({ ...changes, updated_at: Date.now() })
						.where(eq(DB.Tables.collections.id, collection.id));
				}
			}

			await audit(c, "collection.update", collection.id, { changes: body }, tx);

			return await collectionView(collection.id, tx);
		});

		return APIResponse.success(c, "Collection updated successfully", view);
	},
);

router.delete(
	"/:collectionId",

	APIRouteSpec.authenticated({
		summary: "Delete collection",
		description: "Delete a collection. Its products stay on the page without a collection.",
		tags: [DOCS_TAGS.STUDIO.COLLECTIONS],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Collection deleted successfully"),
			APIResponseSpec.forbidden("You are not allowed to manage this page"),
			APIResponseSpec.notFound("Collection not found"),
		),
	}),

	async (c) => {
		const denied = StudioPageContext.deny(c, "manage_content");
		if (denied) return denied;

		const collection = c.get("collection");

		await DB.instance().transaction(async (tx: DrizzleDB) => {
			await tx.delete(DB.Tables.collections).where(eq(DB.Tables.collections.id, collection.id));
			await audit(c, "collection.delete", collection.id, { name: collection.name }, tx);
		});

		return APIResponse.successNoData(c, "Collection deleted successfully");
	},
);
