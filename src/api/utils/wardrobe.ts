import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	like,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { CatalogQueries, CatalogViews } from "./catalogViews";
import { InventoryHandler } from "./inventory";
import { CatalogSettings } from "./shared-models/catalogData";
import type { SharedViews } from "./shared-models/views";

/**
 * The user's wardrobe: the exclusive products they own (always there, can't be removed) plus the
 * free products they saved from the shop. Equipping a free product saves it as well; removing a
 * product from the wardrobe unequips it from every linked Minecraft account. Only public
 * products show. Used by the website's and the mod's wardrobe.
 */
export class WardrobeHandler {
	/** Saved free products per user (owned exclusives don't count). */
	static readonly MAX_SAVED_ITEMS = 500;

	/** Left-joins the user's ownership and wardrobe rows onto `products`. */
	protected static joins(userID: number) {
		return {
			owned: and(
				eq(DB.Tables.userItems.product_id, DB.Tables.products.id),
				eq(DB.Tables.userItems.user_id, userID),
			),
			saved: and(
				eq(DB.Tables.wardrobeItems.product_id, DB.Tables.products.id),
				eq(DB.Tables.wardrobeItems.user_id, userID),
			),
		};
	}

	/** Exclusives come in by ownership, free products by being saved. */
	protected static inWardrobe() {
		return or(
			and(eq(DB.Tables.products.availability, "exclusive"), isNotNull(DB.Tables.userItems.user_id)),
			and(eq(DB.Tables.products.availability, "free"), isNotNull(DB.Tables.wardrobeItems.user_id)),
		);
	}

	static async list(
		userID: number,
		query: WardrobeHandler.Query,
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.WardrobeItem[]> {
		const products = DB.Tables.products;
		const joins = this.joins(userID);

		const conditions: Array<SQL | undefined> = [
			CatalogQueries.publicProduct(),
			query.owned_only
				? and(eq(products.availability, "exclusive"), isNotNull(DB.Tables.userItems.user_id))
				: this.inWardrobe(),
		];
		if (query.type) conditions.push(eq(products.type, query.type));
		if (query.search) conditions.push(like(products.name, `%${query.search}%`));

		const ownedExclusive = sql<number>`(${products.availability} = 'exclusive' and ${DB.Tables.userItems.user_id} is not null)`;
		// Exclusives: when they were received; free products: when they were saved (a free product
		// can still have an ownership row from when it was exclusive).
		const addedAt = sql<number>`case when ${ownedExclusive} then ${DB.Tables.userItems.created_at} else ${DB.Tables.wardrobeItems.created_at} end`;

		const rows = await tx
			.select({
				product: products,
				page: {
					id: DB.Tables.pages.id,
					category: DB.Tables.pages.category,
					slug: DB.Tables.pages.slug,
					name: DB.Tables.pages.name,
				},
				owned: ownedExclusive,
				added_at: addedAt,
			})
			.from(products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, products.page_id))
			.leftJoin(DB.Tables.userItems, joins.owned)
			.leftJoin(DB.Tables.wardrobeItems, joins.saved)
			.where(and(...conditions))
			// owned exclusives first, then the most recently saved
			.orderBy(desc(ownedExclusive), desc(addedAt), asc(products.id))
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
			removable: !row.owned,
			added_at: Number(row.added_at),
		}));
	}

	/** Whether one product is in the user's wardrobe (any product id; unknown ones are not). */
	static async status(
		userID: number,
		productID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.WardrobeStatus> {
		const joins = this.joins(userID);
		const row = await tx
			.select({
				availability: DB.Tables.products.availability,
				owned: DB.Tables.userItems.user_id,
				saved: DB.Tables.wardrobeItems.user_id,
			})
			.from(DB.Tables.products)
			.leftJoin(DB.Tables.userItems, joins.owned)
			.leftJoin(DB.Tables.wardrobeItems, joins.saved)
			.where(eq(DB.Tables.products.id, productID))
			.get();

		const owned = row?.availability === "exclusive" && row.owned !== null;
		const saved = row?.availability === "free" && row.saved !== null;
		return { in_wardrobe: owned || saved, owned, removable: !owned };
	}

	/** Saves a product. Free products only; owned exclusives are already in the wardrobe. */
	static async add(
		userID: number,
		productID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<WardrobeHandler.ChangeResult> {
		const row = await tx
			.select({ product: DB.Tables.products })
			.from(DB.Tables.products)
			.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
			.where(and(eq(DB.Tables.products.id, productID), CatalogQueries.publicProduct()))
			.get();

		if (!row) {
			return { ok: false, code: 404, message: "Product not found" };
		}

		if (row.product.availability === "exclusive") {
			if (await InventoryHandler.owns(userID, productID, tx)) {
				return { ok: true, changed: false };
			}
			return {
				ok: false,
				code: 403,
				message: "Exclusive items join your wardrobe when you redeem a code or get them as a gift",
			};
		}

		const existing = await this.status(userID, productID, tx);
		if (existing.in_wardrobe) {
			return { ok: true, changed: false };
		}

		const saved = await tx
			.select({ value: count() })
			.from(DB.Tables.wardrobeItems)
			.where(eq(DB.Tables.wardrobeItems.user_id, userID))
			.get();
		if ((saved?.value ?? 0) >= this.MAX_SAVED_ITEMS) {
			return {
				ok: false,
				code: 409,
				message: `Your wardrobe is full (${this.MAX_SAVED_ITEMS} saved items). Remove something first.`,
			};
		}

		const inserted = await tx
			.insert(DB.Tables.wardrobeItems)
			.values({ user_id: userID, product_id: productID, created_at: Date.now() })
			.onConflictDoNothing()
			.returning()
			.all();

		return { ok: true, changed: inserted.length > 0 };
	}

	/** Removes a saved product and unequips it from every linked account. Owned exclusives stay. */
	static async remove(
		userID: number,
		productID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<WardrobeHandler.ChangeResult> {
		const current = await this.status(userID, productID, tx);
		if (current.owned) {
			return {
				ok: false,
				code: 409,
				message: "Exclusive items you own always stay in your wardrobe",
			};
		}

		const deleted = await tx
			.delete(DB.Tables.wardrobeItems)
			.where(
				and(
					eq(DB.Tables.wardrobeItems.user_id, userID),
					eq(DB.Tables.wardrobeItems.product_id, productID),
				),
			)
			.returning()
			.all();

		if (deleted.length === 0) {
			return { ok: false, code: 404, message: "This item is not in your wardrobe" };
		}

		await InventoryHandler.unequipForUser(userID, productID, tx);

		return { ok: true, changed: true };
	}

	/** Saves the free products among `productIDs` (called when they get equipped). */
	static async saveEquipped(userID: number, productIDs: number[], tx: DrizzleDB = DB.instance()) {
		const unique = [...new Set(productIDs)];
		if (unique.length === 0) return;

		const free = await tx
			.select({ id: DB.Tables.products.id })
			.from(DB.Tables.products)
			.where(and(inArray(DB.Tables.products.id, unique), eq(DB.Tables.products.availability, "free")))
			.all();
		if (free.length === 0) return;

		await tx
			.insert(DB.Tables.wardrobeItems)
			.values(
				free.map((product) => ({ user_id: userID, product_id: product.id, created_at: Date.now() })),
			)
			.onConflictDoNothing();
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
			.describe("`true`: only the exclusive products the user owns"),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Params = z.object({
		productId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;

	export type ChangeResult =
		| { ok: true; changed: boolean }
		| { ok: false; code: 403 | 404 | 409; message: string };
}
