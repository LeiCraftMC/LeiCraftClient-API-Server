import { and, asc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { AssetStore } from "./assets";
import { DiscordOAuth } from "./discord";
import { CatalogSettings } from "./shared-models/catalogData";
import type { SharedViews } from "./shared-models/views";
import { UserHandler } from "./users";

/** Builds the {@link SharedViews} response objects from DB rows. */
export class CatalogViews {
	static assetRef(assetID: string, extension: "png" | "json"): SharedViews.AssetRef;
	static assetRef(assetID: string | null, extension: "png" | "json"): SharedViews.AssetRef | null;
	static assetRef(assetID: string | null, extension: "png" | "json") {
		if (!assetID) return null;
		return { id: assetID, url: AssetStore.getURL(assetID, extension) };
	}

	static publicUser(
		user: Pick<DB.Models.User, "id" | "display_name" | "discord_id" | "discord_avatar_hash">,
	): SharedViews.PublicUser {
		return {
			id: user.id,
			display_name: user.display_name,
			avatar_url: DiscordOAuth.getAvatarURL(user.discord_id, user.discord_avatar_hash),
		};
	}

	static managedUser(user: DB.Models.User): SharedViews.ManagedUser {
		return {
			id: user.id,
			discord_id: user.discord_id,
			discord_username: user.discord_username,
			display_name: user.display_name,
			avatar_url: DiscordOAuth.getAvatarURL(user.discord_id, user.discord_avatar_hash),
			role: user.role,
			banned: UserHandler.isBanned(user),
			banned_at: user.banned_at,
			banned_until: user.banned_until,
			ban_reason: user.ban_reason,
			created_at: user.created_at,
			last_login_at: user.last_login_at,
		};
	}

	static category(category: CatalogSettings.Category): SharedViews.Category {
		return { id: category, ...CatalogSettings.CategoryInfo[category] };
	}

	static page(page: DB.Models.Page): SharedViews.Page {
		return {
			id: page.id,
			category: page.category,
			slug: page.slug,
			name: page.name,
			description: page.description,
			icon: this.assetRef(page.icon_asset_id, "png"),
			banner: this.assetRef(page.banner_asset_id, "png"),
			sort_order: page.sort_order,
			created_at: page.created_at,
		};
	}

	static collection(collection: DB.Models.Collection): SharedViews.Collection {
		return {
			id: collection.id,
			page_id: collection.page_id,
			name: collection.name,
			description: collection.description,
			preview: this.assetRef(collection.preview_asset_id, "png"),
			sort_order: collection.sort_order,
			created_at: collection.created_at,
		};
	}

	static variant(variant: DB.Models.ProductVariant): SharedViews.Variant {
		return {
			id: variant.id,
			name: variant.name,
			skin_model: variant.skin_model,
			model: this.assetRef(variant.model_asset_id, "json"),
			texture: this.assetRef(variant.texture_asset_id, "png"),
			sort_order: variant.sort_order,
		};
	}

	/** Variants of the given products, ordered, keyed by product id. */
	static async loadVariants(productIDs: number[], tx: DrizzleDB = DB.instance()) {
		const byProduct = new Map<number, DB.Models.ProductVariant[]>();
		if (productIDs.length === 0) {
			return byProduct;
		}

		const variants = await tx
			.select()
			.from(DB.Tables.productVariants)
			.where(inArray(DB.Tables.productVariants.product_id, [...new Set(productIDs)]))
			.orderBy(asc(DB.Tables.productVariants.sort_order), asc(DB.Tables.productVariants.id))
			.all();

		for (const variant of variants) {
			const list = byProduct.get(variant.product_id) ?? [];
			list.push(variant);
			byProduct.set(variant.product_id, list);
		}
		return byProduct;
	}

	static product(
		product: DB.Models.Product,
		variants: DB.Models.ProductVariant[] = [],
	): SharedViews.Product {
		return {
			id: product.id,
			page_id: product.page_id,
			collection_id: product.collection_id,
			type: product.type,
			name: product.name,
			description: product.description,
			availability: product.availability,
			listed: product.listed,
			texture: product.type === "cape" ? this.assetRef(product.texture_asset_id, "png") : null,
			preview: this.assetRef(product.preview_asset_id, "png"),
			variants: product.type === "cosmetic" ? variants.map((v) => this.variant(v)) : [],
			sort_order: product.sort_order,
			published_at: product.published_at,
			created_at: product.created_at,
		};
	}

	static async products(rows: DB.Models.Product[], tx: DrizzleDB = DB.instance()) {
		const variants = await this.loadVariants(
			rows.filter((row) => row.type === "cosmetic").map((row) => row.id),
			tx,
		);
		return rows.map((row) => this.product(row, variants.get(row.id)));
	}

	static async managedProducts(
		rows: DB.Models.Product[],
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.ManagedProduct[]> {
		const products = await this.products(rows, tx);

		const creatorIDs = [
			...new Set(rows.map((row) => row.creator_user_id).filter((id): id is number => id !== null)),
		];
		const creators = creatorIDs.length
			? await tx.select().from(DB.Tables.users).where(inArray(DB.Tables.users.id, creatorIDs)).all()
			: [];
		const creatorsByID = new Map(creators.map((user) => [user.id, user]));

		return rows.map((row, index) => {
			const creator = row.creator_user_id ? creatorsByID.get(row.creator_user_id) : undefined;
			return {
				...(products[index] as SharedViews.Product),
				status: row.status,
				review_note: row.review_note,
				reviewed_at: row.reviewed_at,
				updated_at: row.updated_at,
				creator: creator ? this.publicUser(creator) : null,
			};
		});
	}

	static async managedProduct(row: DB.Models.Product, tx: DrizzleDB = DB.instance()) {
		return (await this.managedProducts([row], tx))[0] as SharedViews.ManagedProduct;
	}
}

/** Query conditions shared by the public read paths. */
export class CatalogQueries {
	/** Community pages are public only after their profile was approved (needs `pages`). */
	static reviewedPage() {
		return or(ne(DB.Tables.pages.category, "community"), isNotNull(DB.Tables.pages.reviewed_at));
	}

	/** Products visible to everyone (needs a join with `pages`). */
	static publicProduct() {
		return and(
			eq(DB.Tables.products.status, "published"),
			eq(DB.Tables.pages.status, "active"),
			this.reviewedPage(),
		);
	}

	/** Collections visible to everyone: on community pages only once reviewed (needs `pages`). */
	static publicCollection() {
		return or(
			ne(DB.Tables.pages.category, "community"),
			isNotNull(DB.Tables.collections.reviewed_at),
		);
	}
}
