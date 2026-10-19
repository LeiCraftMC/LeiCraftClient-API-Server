import { and, asc, eq, inArray } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { CatalogQueries, CatalogViews } from "./catalogViews";
import { MinecraftAccountHandler } from "./minecraftAccounts";
import type { SharedViews } from "./shared-models/views";
import { UserHandler } from "./users";

/**
 * What a Minecraft account wears. The cape is `minecraft_accounts.cape_product_id`, cosmetics are
 * rows in `equipped_cosmetics`. Equipping needs a linked account; a product shows in-game only
 * while it is published, its page is active, the user may use it (free or owned) and the user is
 * not banned — checked again on every read, so takedowns and revocations apply immediately.
 */
export class LoadoutHandler {
	static readonly MAX_EQUIPPED_COSMETICS = 10;

	/** Visible products among `productIDs` and which of them each user owns. */
	protected static async loadVisibility(
		productIDs: number[],
		userIDs: number[],
		tx: DrizzleDB = DB.instance(),
	) {
		const uniqueProductIDs = [...new Set(productIDs)];

		const visible = uniqueProductIDs.length
			? await tx
					.select({ product: DB.Tables.products })
					.from(DB.Tables.products)
					.innerJoin(DB.Tables.pages, eq(DB.Tables.pages.id, DB.Tables.products.page_id))
					.where(and(inArray(DB.Tables.products.id, uniqueProductIDs), CatalogQueries.publicProduct()))
					.all()
			: [];
		const products = new Map(visible.map(({ product }) => [product.id, product]));

		const exclusiveIDs = visible
			.filter(({ product }) => product.availability === "exclusive")
			.map(({ product }) => product.id);
		const uniqueUserIDs = [...new Set(userIDs)];

		const owned =
			exclusiveIDs.length && uniqueUserIDs.length
				? await tx
						.select({
							user_id: DB.Tables.userItems.user_id,
							product_id: DB.Tables.userItems.product_id,
						})
						.from(DB.Tables.userItems)
						.where(
							and(
								inArray(DB.Tables.userItems.user_id, uniqueUserIDs),
								inArray(DB.Tables.userItems.product_id, exclusiveIDs),
							),
						)
						.all()
				: [];
		const ownership = new Set(owned.map((row) => `${row.user_id}:${row.product_id}`));

		return {
			products,
			isUsable(userID: number, productID: number) {
				const product = products.get(productID);
				if (!product) return false;
				return product.availability === "free" || ownership.has(`${userID}:${productID}`);
			},
		};
	}

	protected static async loadEquippedCosmetics(accountIDs: number[], tx: DrizzleDB = DB.instance()) {
		const byAccount = new Map<number, DB.Models.EquippedCosmetic[]>();
		if (accountIDs.length === 0) {
			return byAccount;
		}

		const rows = await tx
			.select()
			.from(DB.Tables.equippedCosmetics)
			.where(inArray(DB.Tables.equippedCosmetics.minecraft_account_id, accountIDs))
			.orderBy(asc(DB.Tables.equippedCosmetics.position))
			.all();

		for (const row of rows) {
			const list = byAccount.get(row.minecraft_account_id) ?? [];
			list.push(row);
			byAccount.set(row.minecraft_account_id, list);
		}
		return byAccount;
	}

	/** The owner's view of the loadout (only items that currently show in-game). */
	static async getLoadout(
		account: DB.Models.MinecraftAccount,
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.Loadout> {
		if (account.user_id === null) {
			return { cape: null, cosmetics: [] };
		}
		const userID = account.user_id;

		const equipped = (await this.loadEquippedCosmetics([account.id], tx)).get(account.id) ?? [];
		const productIDs = [
			...(account.cape_product_id !== null ? [account.cape_product_id] : []),
			...equipped.map((row) => row.product_id),
		];

		const visibility = await this.loadVisibility(productIDs, [userID], tx);
		const usable = (productID: number) => visibility.isUsable(userID, productID);

		const views = new Map(
			(await CatalogViews.products([...visibility.products.values()], tx)).map((view) => [
				view.id,
				view,
			]),
		);

		const cape =
			account.cape_product_id !== null && usable(account.cape_product_id)
				? (views.get(account.cape_product_id) ?? null)
				: null;

		return {
			cape,
			cosmetics: equipped
				.filter((row) => usable(row.product_id))
				.map((row) => ({
					product: views.get(row.product_id) as SharedViews.Product,
					variant_id: row.variant_id,
				})),
		};
	}

	/** Replaces the loadout after validating every item. */
	static async setLoadout(
		account: DB.Models.MinecraftAccount,
		input: LoadoutHandler.Input,
		tx: DrizzleDB = DB.instance(),
	): Promise<LoadoutHandler.SetResult> {
		if (account.user_id === null) {
			return { ok: false, code: 400, message: "This Minecraft account is not linked" };
		}
		const userID = account.user_id;

		if (input.cosmetics.length > this.MAX_EQUIPPED_COSMETICS) {
			return {
				ok: false,
				code: 400,
				message: `At most ${this.MAX_EQUIPPED_COSMETICS} cosmetics can be equipped`,
			};
		}

		const cosmeticIDs = input.cosmetics.map((item) => item.product_id);
		if (new Set(cosmeticIDs).size !== cosmeticIDs.length) {
			return { ok: false, code: 400, message: "A cosmetic can only be equipped once" };
		}

		const productIDs = [
			...(input.cape_product_id !== null ? [input.cape_product_id] : []),
			...cosmeticIDs,
		];
		const visibility = await this.loadVisibility(productIDs, [userID], tx);

		const check = (productID: number, type: DB.Models.Product["type"]) => {
			const product = visibility.products.get(productID);
			if (!product || product.type !== type) {
				return {
					ok: false as const,
					code: 400 as const,
					message: `Product ${productID} is not an available ${type}`,
				};
			}
			if (!visibility.isUsable(userID, productID)) {
				return {
					ok: false as const,
					code: 403 as const,
					message: `You do not own product ${productID}`,
				};
			}
			return null;
		};

		if (input.cape_product_id !== null) {
			const problem = check(input.cape_product_id, "cape");
			if (problem) return problem;
		}

		const variants = await CatalogViews.loadVariants(cosmeticIDs, tx);

		for (const item of input.cosmetics) {
			const problem = check(item.product_id, "cosmetic");
			if (problem) return problem;

			const productVariants = variants.get(item.product_id) ?? [];
			if (productVariants.length === 0) {
				return { ok: false, code: 400, message: `Product ${item.product_id} has no variants` };
			}
			if (
				item.variant_id !== null &&
				item.variant_id !== undefined &&
				!productVariants.some((variant) => variant.id === item.variant_id)
			) {
				return {
					ok: false,
					code: 400,
					message: `Variant ${item.variant_id} does not belong to product ${item.product_id}`,
				};
			}
		}

		await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ cape_product_id: input.cape_product_id })
			.where(eq(DB.Tables.minecraftAccounts.id, account.id));

		await tx
			.delete(DB.Tables.equippedCosmetics)
			.where(eq(DB.Tables.equippedCosmetics.minecraft_account_id, account.id));

		if (input.cosmetics.length > 0) {
			await tx.insert(DB.Tables.equippedCosmetics).values(
				input.cosmetics.map((item, position) => ({
					minecraft_account_id: account.id,
					product_id: item.product_id,
					variant_id: item.variant_id ?? null,
					position,
				})),
			);
		}

		return { ok: true };
	}

	/** Public, render-ready profiles of the given accounts (same order). */
	static async getProfiles(
		accounts: DB.Models.MinecraftAccount[],
		tx: DrizzleDB = DB.instance(),
	): Promise<SharedViews.PlayerProfile[]> {
		const userIDs = [
			...new Set(accounts.map((account) => account.user_id).filter((id): id is number => id !== null)),
		];

		const users = userIDs.length
			? await tx.select().from(DB.Tables.users).where(inArray(DB.Tables.users.id, userIDs)).all()
			: [];
		const activeUsers = new Set(
			users.filter((user) => !UserHandler.isBanned(user)).map((user) => user.id),
		);

		const wearing = accounts.filter(
			(account) => account.user_id !== null && activeUsers.has(account.user_id),
		);

		const equipped = await this.loadEquippedCosmetics(
			wearing.map((account) => account.id),
			tx,
		);

		const productIDs = wearing.flatMap((account) => [
			...(account.cape_product_id !== null ? [account.cape_product_id] : []),
			...(equipped.get(account.id) ?? []).map((row) => row.product_id),
		]);

		const visibility = await this.loadVisibility(productIDs, [...activeUsers], tx);
		const variants = await CatalogViews.loadVariants(
			[...visibility.products.values()]
				.filter((product) => product.type === "cosmetic")
				.map((product) => product.id),
			tx,
		);

		return accounts.map((account) => {
			const profile: SharedViews.PlayerProfile = {
				uuid: account.uuid,
				name: account.name,
				uses_client: MinecraftAccountHandler.usesClient(account),
				cape: null,
				cosmetics: [],
			};

			if (account.user_id === null || !activeUsers.has(account.user_id)) {
				return profile;
			}
			const userID = account.user_id;

			if (account.cape_product_id !== null && visibility.isUsable(userID, account.cape_product_id)) {
				const cape = visibility.products.get(account.cape_product_id);
				if (cape?.type === "cape" && cape.texture_asset_id) {
					profile.cape = {
						product_id: cape.id,
						texture: CatalogViews.assetRef(cape.texture_asset_id, "png"),
					};
				}
			}

			for (const row of equipped.get(account.id) ?? []) {
				if (!visibility.isUsable(userID, row.product_id)) continue;

				const productVariants = variants.get(row.product_id) ?? [];
				if (productVariants.length === 0) continue;

				profile.cosmetics.push({
					product_id: row.product_id,
					variant_id: row.variant_id,
					variants: productVariants.map((variant) => CatalogViews.variant(variant)),
				});
			}

			return profile;
		});
	}
}

export namespace LoadoutHandler {
	export interface Input {
		cape_product_id: number | null;
		cosmetics: Array<{ product_id: number; variant_id?: number | null }>;
	}

	export type SetResult = { ok: true } | { ok: false; code: 400 | 403; message: string };
}
