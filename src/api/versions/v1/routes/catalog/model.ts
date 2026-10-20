import { z } from "zod";
import { CatalogSettings } from "../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../utils/shared-models/views";

const Pagination = {
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
};

const Search = z.string().trim().min(1).max(64);

export namespace CatalogModel {
	export const PageWithCount = SharedViews.Page.extend({
		product_count: z.number().int().describe("Number of public, listed products"),
	});
	export type PageWithCount = z.infer<typeof PageWithCount>;

	export const PageDetail = PageWithCount.extend({
		owner: SharedViews.PublicUser.nullable().describe("Creator of a community page"),
	});
	export type PageDetail = z.infer<typeof PageDetail>;

	export const CollectionWithCount = SharedViews.Collection.extend({
		product_count: z.number().int(),
	});
	export type CollectionWithCount = z.infer<typeof CollectionWithCount>;
}

export namespace CatalogModel.GetCategories {
	export const Response = z.array(
		SharedViews.Category.extend({
			page_count: z.number().int(),
			product_count: z.number().int().describe("Listed, published products of the category"),
		}),
	);
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetPages {
	export const Query = z.object({
		category: CatalogSettings.Category.optional(),
		search: Search.optional(),
		...Pagination,
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(CatalogModel.PageWithCount);
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetPage {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;

	export const Response = CatalogModel.PageDetail;
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetPageBySlug {
	export const Params = z.object({
		category: CatalogSettings.Category,
		slug: z.string().min(1).max(64),
	});
	export type Params = z.infer<typeof Params>;

	export const Response = CatalogModel.PageDetail;
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetPageCollections {
	export const Response = z.array(CatalogModel.CollectionWithCount);
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetCollection {
	export const Params = z.object({
		collectionId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;

	export const Response = z.object({
		collection: SharedViews.Collection,
		page: SharedViews.Page,
		products: z.array(SharedViews.Product),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetProducts {
	export const Query = z.object({
		page_id: z.coerce.number().int().positive().optional(),
		collection_id: z.coerce.number().int().positive().optional(),
		category: CatalogSettings.Category.optional(),
		type: CatalogSettings.ProductType.optional(),
		availability: CatalogSettings.ProductAvailability.optional(),
		search: Search.optional(),
		order: z
			.enum(["featured", "newest", "oldest", "name"])
			.default("featured")
			.describe("`featured` = the page's own order, newest first"),
		...Pagination,
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.Product);
	export type Response = z.infer<typeof Response>;
}

export namespace CatalogModel.GetProduct {
	export const Params = z.object({
		productId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;

	export const Response = SharedViews.Product.extend({
		page: SharedViews.Page,
		collection: SharedViews.Collection.nullable(),
		creator: SharedViews.PublicUser.nullable(),
		equip_count: z.number().int().describe("How many Minecraft accounts have it equipped"),
	});
	export type Response = z.infer<typeof Response>;
}
