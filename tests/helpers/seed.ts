import { randomUUID } from "node:crypto";
import { AssetStore, AssetValidator } from "../../src/api/utils/assets";
import { ClientSessionHandler, SessionHandler } from "../../src/api/utils/authHandler";
import type { AssetSettings, CatalogSettings } from "../../src/api/utils/shared-models/catalogData";
import { DB } from "../../src/db";
import { createModel, createPNG } from "./png";

export type SeededUser = DB.Models.User;
export type SeededSession = Awaited<ReturnType<typeof SessionHandler.createSession>>;

let discordCounter = 200000000000000000n;

/** A unique, valid-looking Discord snowflake. */
export function nextDiscordID() {
	discordCounter += 1n;
	return discordCounter.toString();
}

export async function seedUser(
	role: DB.Models.User["role"] = "user",
	overrides: Partial<DB.Models.User> = {},
): Promise<SeededUser> {
	const discordID = overrides.discord_id ?? nextDiscordID();

	return await DB.instance()
		.insert(DB.Tables.users)
		.values({
			discord_id: discordID,
			discord_username: overrides.discord_username ?? `user_${randomUUID().slice(0, 8)}`,
			display_name: overrides.display_name ?? "Test User",
			discord_avatar_hash: overrides.discord_avatar_hash ?? null,
			role,
			banned_at: overrides.banned_at ?? null,
			banned_until: overrides.banned_until ?? null,
			ban_reason: overrides.ban_reason ?? null,
		})
		.returning()
		.get();
}

export async function seedSession(user_id: number): Promise<SeededSession> {
	return await SessionHandler.createSession(user_id);
}

/** A user with a website session token. */
export async function seedUserWithSession(role: DB.Models.User["role"] = "user") {
	const user = await seedUser(role);
	const session = await seedSession(user.id);
	return { user, token: session.token };
}

export function randomMinecraftUUID() {
	return randomUUID();
}

export function randomMinecraftName() {
	return `mc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

/** A Minecraft account as if verified through the mod, optionally linked to a user. */
export async function seedMinecraftAccount(
	userID: number | null,
	overrides: Partial<DB.Models.MinecraftAccount> = {},
) {
	const now = Date.now();
	return await DB.instance()
		.insert(DB.Tables.minecraftAccounts)
		.values({
			uuid: overrides.uuid ?? randomMinecraftUUID(),
			name: overrides.name ?? randomMinecraftName(),
			user_id: userID,
			linked_at: userID !== null ? now : null,
			skin_model: overrides.skin_model ?? "wide",
			cape_product_id: overrides.cape_product_id ?? null,
			last_seen_at: overrides.last_seen_at ?? now,
			updated_at: now,
		})
		.returning()
		.get();
}

export async function seedClientSession(minecraftAccountID: number) {
	return await ClientSessionHandler.createClientSession(minecraftAccountID);
}

export async function seedPage(
	category: CatalogSettings.Category,
	ownerID: number | null,
	overrides: Partial<DB.Models.Page> = {},
) {
	const page = await DB.instance()
		.insert(DB.Tables.pages)
		.values({
			category,
			slug: overrides.slug ?? `page-${randomUUID().slice(0, 8)}`,
			name: overrides.name ?? "Test Page",
			status: overrides.status ?? "active",
			// community pages: already approved unless the test wants the review flow
			reviewed_at: overrides.reviewed_at === undefined ? Date.now() : overrides.reviewed_at,
		})
		.returning()
		.get();

	if (ownerID !== null) {
		await DB.instance()
			.insert(DB.Tables.pageMembers)
			.values({ page_id: page.id, user_id: ownerID, role: "owner" });
	}

	return page;
}

/** Stores a valid asset of the given kind. `seed` varies the bytes so ids differ. */
export async function seedAsset(kind: AssetSettings.Kind, seed = Math.floor(Math.random() * 250)) {
	const bytes =
		kind === "cosmetic_model"
			? new TextEncoder().encode(
					JSON.stringify(createModel({ credit: `seed ${seed} ${randomUUID()}` })),
				)
			: kind === "cape_texture"
				? createPNG(64, 32, [seed, 0, 0, 255])
				: createPNG(32, 32, [0, seed, 0, 255]);

	const validation = AssetValidator.validate(kind, bytes);
	if (!validation.ok) {
		throw new Error(`seedAsset: ${validation.error}`);
	}
	return await AssetStore.store(validation.asset, null);
}

/** A published product, ready to equip. Cosmetics get one variant. */
export async function seedProduct(
	pageID: number,
	type: CatalogSettings.ProductType,
	overrides: Partial<DB.Models.Product> = {},
) {
	const texture = type === "cape" ? await seedAsset("cape_texture") : null;

	const product = await DB.instance()
		.insert(DB.Tables.products)
		.values({
			page_id: pageID,
			type,
			name: overrides.name ?? `${type} ${randomUUID().slice(0, 6)}`,
			status: overrides.status ?? "published",
			availability: overrides.availability ?? "free",
			listed: overrides.listed ?? true,
			texture_asset_id: texture?.id ?? null,
			published_at: Date.now(),
			collection_id: overrides.collection_id ?? null,
		})
		.returning()
		.get();

	let variant: DB.Models.ProductVariant | null = null;
	if (type === "cosmetic") {
		const model = await seedAsset("cosmetic_model");
		const cosmeticTexture = await seedAsset("cosmetic_texture");
		variant = await DB.instance()
			.insert(DB.Tables.productVariants)
			.values({
				product_id: product.id,
				name: "Default",
				skin_model: "any",
				model_asset_id: model.id,
				texture_asset_id: cosmeticTexture.id,
			})
			.returning()
			.get();
	}

	return { product, variant };
}
