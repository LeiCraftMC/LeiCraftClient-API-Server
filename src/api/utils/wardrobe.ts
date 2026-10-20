import { and, asc, desc, eq, exists, like, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { CatalogQueries, CatalogViews } from "./catalogViews";
import { CatalogSettings } from "./shared-models/catalogData";
import type { SharedViews } from "./shared-models/views";

/**
 * What a user can equip: public products that are free and listed, plus the exclusive products
 * they own (listed or not). Used by the website's and the mod's wardrobe.
 */
export class WardrobeHandler {
	static async list(
		userID: number,
		query: WardrobeHandler.Query,
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.WardrobeItem[]> {
		const products = DB.Tables.products;

		const owned = exists(
			tx
				.select({ one: sql`1` })
				.from(DB.Tables.userItems)
				.where(
					and(eq(DB.Tables.userItems.product_id, products.id), eq(DB.Tables.userItems.user_id, userID)),
				),
		);

		const conditions: Array<SQL | undefined> = [
			CatalogQueries.publicProduct(),
			query.owned_only
				? owned
				: or(and(eq(products.availability, "free"), eq(products.listed, true)), owned),
		];
		if (query.type) conditions.push(eq(products.type, query.type));
		if (query.search) conditions.push(like(products.name, `%${query.search}%`));

		const rows = await tx
			.select({
				product: products,
				page: {
					id: DB.Tables.pages.id,
					category: DB.Tables.pages.category,
					slug: DB.Tables.pages.slug,
					name: DB.Tables.pages.name,
				},
				owned: sql<number>`${owned}`,
			})
			.from(products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, products.page_id))
			.where(and(...conditions))
			// owned items first, then the catalog order
			.orderBy(
				desc(sql`${owned}`),
				asc(DB.Tables.pages.sort_order),
				desc(products.published_at),
				asc(products.id),
			)
			.limit(query.limit)
			.offset(query.offset)
			.all();

		const views = await CatalogViews.products(
			rows.map((row) => row.product),
			tx,
		);

		return rows.map((row, index) => ({
			product: views[index] as SharedViews.Product,
			page: row.page,
			owned: Boolean(row.owned),
		}));
	}
}

export namespace WardrobeHandler {
	export const Query = z.object({
		type: CatalogSettings.ProductType.optional(),
		search: z.string().trim().min(1).max(64).optional(),
		owned_only: z
			.enum(["true", "false"])
			.transform((value) => value === "true")
			.optional()
			.describe("`true`: only exclusive products the user owns"),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;
}
