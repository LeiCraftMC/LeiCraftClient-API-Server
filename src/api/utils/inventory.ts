import { and, eq, inArray } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import type { CatalogSettings } from "./shared-models/catalogData";

/**
 * Ownership of exclusive products (`user_items`). Free products need no ownership row; exclusive
 * ones are owned through a redeem code or a direct grant from the page.
 */
export class InventoryHandler {
	static async ownedProductIDs(
		userID: number,
		productIDs?: number[],
		tx: DrizzleDB = DB.instance(),
	): Promise<Set<number>> {
		if (productIDs && productIDs.length === 0) {
			return new Set();
		}

		const rows = await tx
			.select({ product_id: DB.Tables.userItems.product_id })
			.from(DB.Tables.userItems)
			.where(
				productIDs
					? and(
							eq(DB.Tables.userItems.user_id, userID),
							inArray(DB.Tables.userItems.product_id, productIDs),
						)
					: eq(DB.Tables.userItems.user_id, userID),
			)
			.all();

		return new Set(rows.map((row) => row.product_id));
	}

	static async owns(userID: number, productID: number, tx: DrizzleDB = DB.instance()) {
		return (await this.ownedProductIDs(userID, [productID], tx)).has(productID);
	}

	/** Whether the user may equip the product (ignores the product's status). */
	static async canUse(
		userID: number,
		product: Pick<DB.Models.Product, "id" | "availability">,
		tx: DrizzleDB = DB.instance(),
	) {
		return product.availability === "free" || (await this.owns(userID, product.id, tx));
	}

	/** Adds the product to the inventory. Returns false if the user already owned it. */
	static async grant(
		userID: number,
		productID: number,
		options: {
			source: CatalogSettings.ItemSource;
			granted_by_user_id?: number | null;
			redeem_code_id?: number | null;
			note?: string | null;
		},
		tx: DrizzleDB = DB.instance(),
	) {
		const inserted = await tx
			.insert(DB.Tables.userItems)
			.values({
				user_id: userID,
				product_id: productID,
				source: options.source,
				granted_by_user_id: options.granted_by_user_id ?? null,
				redeem_code_id: options.redeem_code_id ?? null,
				note: options.note ?? null,
			})
			.onConflictDoNothing()
			.returning()
			.all();

		return inserted.length > 0;
	}

	/** Removes the product from the inventory and unequips it everywhere. False if not owned. */
	static async revoke(userID: number, productID: number, tx: DrizzleDB = DB.instance()) {
		const deleted = await tx
			.delete(DB.Tables.userItems)
			.where(
				and(eq(DB.Tables.userItems.user_id, userID), eq(DB.Tables.userItems.product_id, productID)),
			)
			.returning()
			.all();

		await this.unequipForUser(userID, productID, tx);

		return deleted.length > 0;
	}

	/** Unequips a product from every Minecraft account linked to the user. */
	static async unequipForUser(userID: number, productID: number, tx: DrizzleDB = DB.instance()) {
		const accountIDs = (
			await tx
				.select({ id: DB.Tables.minecraftAccounts.id })
				.from(DB.Tables.minecraftAccounts)
				.where(eq(DB.Tables.minecraftAccounts.user_id, userID))
				.all()
		).map((row) => row.id);

		if (accountIDs.length === 0) {
			return;
		}

		await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ cape_product_id: null })
			.where(
				and(
					inArray(DB.Tables.minecraftAccounts.id, accountIDs),
					eq(DB.Tables.minecraftAccounts.cape_product_id, productID),
				),
			);

		await tx
			.delete(DB.Tables.equippedCosmetics)
			.where(
				and(
					inArray(DB.Tables.equippedCosmetics.minecraft_account_id, accountIDs),
					eq(DB.Tables.equippedCosmetics.product_id, productID),
				),
			);
	}
}
