import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	inArray,
	like,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../db";
import { APIResponse } from "../../../../utils/api-res";
import { CatalogQueries, CatalogViews } from "../../../../utils/catalogViews";
import { CatalogSettings } from "../../../../utils/shared-models/catalogData";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { CatalogModel } from "./model";

/** Products that appear in public listings. Needs a join with `pages`. */
function listedPublicProduct() {
	return and(CatalogQueries.publicProduct(), eq(DB.Tables.products.listed, true));
}

/** Active pages; community pages only once reviewed and with something to show. */
function visiblePage() {
	return and(
		eq(DB.Tables.pages.status, "active"),
		CatalogQueries.reviewedPage(),
		or(
			ne(DB.Tables.pages.category, "community"),
			exists(
				DB.instance()
					.select({ one: sql`1` })
					.from(DB.Tables.products)
					.where(
						and(
							eq(DB.Tables.products.page_id, DB.Tables.pages.id),
							eq(DB.Tables.products.status, "published"),
							eq(DB.Tables.products.listed, true),
						),
					),
			),
		),
	);
}

async function countListedProducts(pageIDs: number[]) {
	if (pageIDs.length === 0) {
		return new Map<number, number>();
	}

	const rows = await DB.instance()
		.select({ page_id: DB.Tables.products.page_id, value: count() })
		.from(DB.Tables.products)
		.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
		.where(and(inArray(DB.Tables.products.page_id, pageIDs), listedPublicProduct()))
		.groupBy(DB.Tables.products.page_id)
		.all();

	return new Map(rows.map((row) => [row.page_id, row.value]));
}

async function getPageDetail(page: DB.Models.Page): Promise<CatalogModel.PageDetail> {
	const productCount = (await countListedProducts([page.id])).get(page.id) ?? 0;

	let owner: CatalogModel.PageDetail["owner"] = null;
	if (page.category === "community") {
		const ownerRow = await DB.instance()
			.select({ user: DB.Tables.users })
			.from(DB.Tables.pageMembers)
			.innerJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.pageMembers.user_id))
			.where(and(eq(DB.Tables.pageMembers.page_id, page.id), eq(DB.Tables.pageMembers.role, "owner")))
			.get();
		owner = ownerRow ? CatalogViews.publicUser(ownerRow.user) : null;
	}

	return { ...CatalogViews.page(page), product_count: productCount, owner };
}

export const router = new Hono().basePath("/catalog");

router.get(
	"/categories",

	APIRouteSpec.unauthenticated({
		summary: "List categories",
		description:
			"The three fixed shop categories — `official` (the single page of the LeiCraftClient team), `partner` (official partner pages) and `community` (user uploads) — with their number of visible pages and listed products.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.success(
				"Categories retrieved successfully",
				CatalogModel.GetCategories.Response,
			),
		),
	}),

	async (c) => {
		const rows = await DB.instance()
			.select({ category: DB.Tables.pages.category, value: count() })
			.from(DB.Tables.pages)
			.where(visiblePage())
			.groupBy(DB.Tables.pages.category)
			.all();
		const counts = new Map(rows.map((row) => [row.category, row.value]));

		const productRows = await DB.instance()
			.select({ category: DB.Tables.pages.category, value: count() })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(listedPublicProduct())
			.groupBy(DB.Tables.pages.category)
			.all();
		const productCounts = new Map(productRows.map((row) => [row.category, row.value]));

		return APIResponse.success(
			c,
			"Categories retrieved successfully",
			CatalogSettings.Categories.map((category) => ({
				...CatalogViews.category(category),
				page_count: counts.get(category) ?? 0,
				product_count: productCounts.get(category) ?? 0,
			})) satisfies CatalogModel.GetCategories.Response,
		);
	},
);

router.get(
	"/pages",

	APIRouteSpec.unauthenticated({
		summary: "List pages",
		description:
			"Visible shop pages, optionally filtered by category or name. Community pages are listed once they have a published product.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Pages retrieved successfully", CatalogModel.GetPages.Response),
		),
	}),

	zValidator("query", CatalogModel.GetPages.Query),

	async (c) => {
		const query = c.req.valid("query") as CatalogModel.GetPages.Query;

		const conditions: Array<SQL | undefined> = [visiblePage()];
		if (query.category) {
			conditions.push(eq(DB.Tables.pages.category, query.category));
		}
		if (query.search) {
			conditions.push(like(DB.Tables.pages.name, `%${query.search}%`));
		}

		const pages = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(and(...conditions))
			.orderBy(asc(DB.Tables.pages.sort_order), asc(DB.Tables.pages.name))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		const counts = await countListedProducts(pages.map((page) => page.id));

		return APIResponse.success(
			c,
			"Pages retrieved successfully",
			pages.map((page) => ({
				...CatalogViews.page(page),
				product_count: counts.get(page.id) ?? 0,
			})) satisfies CatalogModel.GetPages.Response,
		);
	},
);

router.get(
	"/pages/by-slug/:category/:slug",

	APIRouteSpec.unauthenticated({
		summary: "Get page by slug",
		description:
			"A visible page by its category and slug (for website URLs like `/shop/partner/<slug>`).",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page retrieved successfully", CatalogModel.GetPageBySlug.Response),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("param", CatalogModel.GetPageBySlug.Params),

	async (c) => {
		const { category, slug } = c.req.valid("param");

		const page = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(
				and(eq(DB.Tables.pages.category, category), eq(DB.Tables.pages.slug, slug), visiblePage()),
			)
			.get();

		if (!page) {
			return APIResponse.notFound(c, "Page not found");
		}

		return APIResponse.success(c, "Page retrieved successfully", await getPageDetail(page));
	},
);

router.get(
	"/pages/:pageId",

	APIRouteSpec.unauthenticated({
		summary: "Get page",
		description:
			"A visible page with its number of public products and, for community pages, its creator.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Page retrieved successfully", CatalogModel.GetPage.Response),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("param", CatalogModel.GetPage.Params),

	async (c) => {
		const { pageId } = c.req.valid("param");

		const page = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(and(eq(DB.Tables.pages.id, pageId), visiblePage()))
			.get();

		if (!page) {
			return APIResponse.notFound(c, "Page not found");
		}

		return APIResponse.success(c, "Page retrieved successfully", await getPageDetail(page));
	},
);

router.get(
	"/pages/:pageId/collections",

	APIRouteSpec.unauthenticated({
		summary: "List page collections",
		description: "Collections of a visible page that contain at least one public product.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Collections retrieved successfully",
				CatalogModel.GetPageCollections.Response,
			),
			APIResponseSpec.notFound("Page not found"),
		),
	}),

	zValidator("param", CatalogModel.GetPage.Params),

	async (c) => {
		const { pageId } = c.req.valid("param");

		const page = await DB.instance()
			.select()
			.from(DB.Tables.pages)
			.where(and(eq(DB.Tables.pages.id, pageId), visiblePage()))
			.get();

		if (!page) {
			return APIResponse.notFound(c, "Page not found");
		}

		const rows = await DB.instance()
			.select({ collection: DB.Tables.collections, product_count: count(DB.Tables.products.id) })
			.from(DB.Tables.collections)
			.innerJoin(DB.Tables.products, eq(DB.Tables.products.collection_id, DB.Tables.collections.id))
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(
				and(
					eq(DB.Tables.collections.page_id, page.id),
					listedPublicProduct(),
					CatalogQueries.publicCollection(),
				),
			)
			.groupBy(DB.Tables.collections.id)
			.orderBy(asc(DB.Tables.collections.sort_order), asc(DB.Tables.collections.name))
			.all();

		return APIResponse.success(
			c,
			"Collections retrieved successfully",
			rows.map((row) => ({
				...CatalogViews.collection(row.collection),
				product_count: row.product_count,
			})) satisfies CatalogModel.GetPageCollections.Response,
		);
	},
);

router.get(
	"/collections/:collectionId",

	APIRouteSpec.unauthenticated({
		summary: "Get collection",
		description: "A collection with its public, listed products.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Collection retrieved successfully",
				CatalogModel.GetCollection.Response,
			),
			APIResponseSpec.notFound("Collection not found"),
		),
	}),

	zValidator("param", CatalogModel.GetCollection.Params),

	async (c) => {
		const { collectionId } = c.req.valid("param");

		const row = await DB.instance()
			.select({ collection: DB.Tables.collections, page: DB.Tables.pages })
			.from(DB.Tables.collections)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.collections.page_id))
			.where(
				and(
					eq(DB.Tables.collections.id, collectionId),
					visiblePage(),
					CatalogQueries.publicCollection(),
				),
			)
			.get();

		if (!row) {
			return APIResponse.notFound(c, "Collection not found");
		}

		const products = await DB.instance()
			.select({ product: DB.Tables.products })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(and(eq(DB.Tables.products.collection_id, collectionId), listedPublicProduct()))
			.orderBy(asc(DB.Tables.products.sort_order), desc(DB.Tables.products.published_at))
			.all();

		if (products.length === 0) {
			return APIResponse.notFound(c, "Collection not found");
		}

		return APIResponse.success(c, "Collection retrieved successfully", {
			collection: CatalogViews.collection(row.collection),
			page: CatalogViews.page(row.page),
			products: await CatalogViews.products(products.map((p) => p.product)),
		} satisfies CatalogModel.GetCollection.Response);
	},
);

router.get(
	"/products",

	APIRouteSpec.unauthenticated({
		summary: "List products",
		description:
			"Public, listed products with optional filters. Unlisted products (e.g. secret exclusives) are only reachable by id.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Products retrieved successfully", CatalogModel.GetProducts.Response),
		),
	}),

	zValidator("query", CatalogModel.GetProducts.Query),

	async (c) => {
		const query = c.req.valid("query") as CatalogModel.GetProducts.Query;

		const conditions: Array<SQL | undefined> = [listedPublicProduct()];
		if (query.page_id) conditions.push(eq(DB.Tables.products.page_id, query.page_id));
		if (query.collection_id)
			conditions.push(eq(DB.Tables.products.collection_id, query.collection_id));
		if (query.category) conditions.push(eq(DB.Tables.pages.category, query.category));
		if (query.type) conditions.push(eq(DB.Tables.products.type, query.type));
		if (query.availability) conditions.push(eq(DB.Tables.products.availability, query.availability));
		if (query.search) conditions.push(like(DB.Tables.products.name, `%${query.search}%`));

		const order = {
			featured: [asc(DB.Tables.products.sort_order), desc(DB.Tables.products.published_at)],
			newest: [desc(DB.Tables.products.published_at)],
			oldest: [asc(DB.Tables.products.published_at)],
			name: [asc(DB.Tables.products.name)],
		}[query.order];

		const rows = await DB.instance()
			.select({ product: DB.Tables.products })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(and(...conditions))
			.orderBy(...order, asc(DB.Tables.products.id))
			.limit(query.limit)
			.offset(query.offset)
			.all();

		return APIResponse.success(
			c,
			"Products retrieved successfully",
			await CatalogViews.products(rows.map((row) => row.product)),
		);
	},
);

router.get(
	"/products/:productId",

	APIRouteSpec.unauthenticated({
		summary: "Get product",
		description:
			"A public product (listed or unlisted) with its page, collection, creator and equip count.",
		tags: [DOCS_TAGS.CATALOG],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Product retrieved successfully", CatalogModel.GetProduct.Response),
			APIResponseSpec.notFound("Product not found"),
		),
	}),

	zValidator("param", CatalogModel.GetProduct.Params),

	async (c) => {
		const { productId } = c.req.valid("param");

		const row = await DB.instance()
			.select({ product: DB.Tables.products, page: DB.Tables.pages })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(and(eq(DB.Tables.products.id, productId), CatalogQueries.publicProduct()))
			.get();

		if (!row) {
			return APIResponse.notFound(c, "Product not found");
		}

		const [product] = await CatalogViews.products([row.product]);

		const collection = row.product.collection_id
			? await DB.instance()
					.select()
					.from(DB.Tables.collections)
					.where(eq(DB.Tables.collections.id, row.product.collection_id))
					.get()
			: undefined;

		const creator = row.product.creator_user_id
			? await DB.instance()
					.select()
					.from(DB.Tables.users)
					.where(eq(DB.Tables.users.id, row.product.creator_user_id))
					.get()
			: undefined;

		const equipCount =
			row.product.type === "cape"
				? await DB.instance()
						.select({ value: count() })
						.from(DB.Tables.minecraftAccounts)
						.where(eq(DB.Tables.minecraftAccounts.cape_product_id, productId))
						.get()
				: await DB.instance()
						.select({ value: count() })
						.from(DB.Tables.equippedCosmetics)
						.where(eq(DB.Tables.equippedCosmetics.product_id, productId))
						.get();

		return APIResponse.success(c, "Product retrieved successfully", {
			...(product as CatalogModel.GetProduct.Response),
			page: CatalogViews.page(row.page),
			// collections of community pages show only once reviewed
			collection:
				collection && (row.page.category !== "community" || collection.reviewed_at !== null)
					? CatalogViews.collection(collection)
					: null,
			creator: creator ? CatalogViews.publicUser(creator) : null,
			equip_count: equipCount?.value ?? 0,
		} satisfies CatalogModel.GetProduct.Response);
	},
);
