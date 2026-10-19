import { count, eq } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { CatalogSettings } from "./shared-models/catalogData";

/**
 * Status transitions of products in the studio.
 *
 * Official and partner products go `draft → published` directly (partners are self-service).
 * Community products go `draft → pending_review → published` (or `rejected`), and any content
 * change to a live or waiting community product sends it back to `pending_review`.
 * `disabled` is set and cleared only by moderators.
 */
export class ProductLifecycle {
	static readonly MAX_VARIANTS = 8;

	/** What is missing before the product can go live, or null. */
	static async getCompletenessProblem(product: DB.Models.Product, tx: DrizzleDB = DB.instance()) {
		if (product.type === "cape") {
			return product.texture_asset_id ? null : "A cape needs a texture before it can be published";
		}

		const variants =
			(
				await tx
					.select({ value: count() })
					.from(DB.Tables.productVariants)
					.where(eq(DB.Tables.productVariants.product_id, product.id))
					.get()
			)?.value ?? 0;

		return variants > 0 ? null : "A cosmetic needs at least one variant before it can be published";
	}

	static async publish(
		product: DB.Models.Product,
		category: CatalogSettings.Category,
		tx: DrizzleDB = DB.instance(),
	): Promise<ProductLifecycle.Result> {
		if (product.status === "disabled") {
			return { ok: false, code: 403, message: "This product was taken down by a moderator" };
		}

		const problem = await this.getCompletenessProblem(product, tx);
		if (problem) {
			return { ok: false, code: 400, message: problem };
		}

		if (product.status === "published" || product.status === "pending_review") {
			return { ok: true, product };
		}

		const now = Date.now();
		const updated = await tx
			.update(DB.Tables.products)
			.set(
				CatalogSettings.requiresReview(category)
					? { status: "pending_review", review_note: null, updated_at: now }
					: {
							status: "published",
							review_note: null,
							published_at: product.published_at ?? now,
							updated_at: now,
						},
			)
			.where(eq(DB.Tables.products.id, product.id))
			.returning()
			.get();

		return { ok: true, product: updated };
	}

	static async unpublish(
		product: DB.Models.Product,
		tx: DrizzleDB = DB.instance(),
	): Promise<ProductLifecycle.Result> {
		if (product.status === "disabled") {
			return { ok: false, code: 403, message: "This product was taken down by a moderator" };
		}

		if (product.status === "draft") {
			return { ok: true, product };
		}

		const updated = await tx
			.update(DB.Tables.products)
			.set({ status: "draft", updated_at: Date.now() })
			.where(eq(DB.Tables.products.id, product.id))
			.returning()
			.get();

		return { ok: true, product: updated };
	}

	/**
	 * Call after the visible content (name, description, textures, variants) of a product changed.
	 * Community products that are live or waiting go back to the review queue.
	 */
	static async onContentChanged(
		productID: number,
		category: CatalogSettings.Category,
		tx: DrizzleDB = DB.instance(),
	) {
		const product = await tx
			.select()
			.from(DB.Tables.products)
			.where(eq(DB.Tables.products.id, productID))
			.get();
		if (!product) return;

		const needsReview =
			CatalogSettings.requiresReview(category) &&
			(product.status === "published" || product.status === "pending_review");

		await tx
			.update(DB.Tables.products)
			.set(
				needsReview ? { status: "pending_review", updated_at: Date.now() } : { updated_at: Date.now() },
			)
			.where(eq(DB.Tables.products.id, productID));
	}
}

export namespace ProductLifecycle {
	export type Result =
		| { ok: true; product: DB.Models.Product }
		| { ok: false; code: 400 | 403; message: string };

	/** Product fields whose change needs a new review on community pages. */
	export const REVIEWED_FIELDS = [
		"name",
		"description",
		"texture_asset_id",
		"preview_asset_id",
	] as const;
}
