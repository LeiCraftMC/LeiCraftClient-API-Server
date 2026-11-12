import { z } from "zod";
import { MinecraftDataPolicies, UserAccountSettings } from "./accountData";
import { CatalogSettings } from "./catalogData";

/**
 * Response shapes shared by several routers (catalog, studio, account, players, moderation).
 * Built from DB rows by `CatalogViews` (src/api/utils/catalogViews.ts).
 */
export namespace SharedViews {
	/** A stored file. `url` is immutable and may be cached forever; `id` is its SHA-256. */
	export const AssetRef = z.object({
		id: z.string(),
		url: z.string(),
	});
	export type AssetRef = z.infer<typeof AssetRef>;

	/** What everyone may see of a user. */
	export const PublicUser = z.object({
		id: z.number().int(),
		display_name: z.string(),
		avatar_url: z.string(),
	});
	export type PublicUser = z.infer<typeof PublicUser>;

	/** A user as moderators and admins see it. */
	export const ManagedUser = z.object({
		id: z.number().int(),
		discord_id: z.string(),
		discord_username: z.string(),
		display_name: z.string(),
		avatar_url: z.string(),
		role: UserAccountSettings.Role,
		banned: z.boolean(),
		banned_at: z.number().int().nullable(),
		banned_until: z.number().int().nullable().describe("null while banned = permanent"),
		ban_reason: z.string().nullable(),
		created_at: z.number().int(),
		last_login_at: z.number().int().nullable(),
	});
	export type ManagedUser = z.infer<typeof ManagedUser>;

	export const Category = z.object({
		id: CatalogSettings.Category,
		name: z.string(),
		description: z.string(),
	});
	export type Category = z.infer<typeof Category>;

	export const Page = z.object({
		id: z.number().int(),
		category: CatalogSettings.Category,
		slug: z.string(),
		name: z.string(),
		description: z.string(),
		icon: AssetRef.nullable(),
		banner: AssetRef.nullable(),
		sort_order: z.number().int(),
		created_at: z.number().int(),
	});
	export type Page = z.infer<typeof Page>;

	export const Collection = z.object({
		id: z.number().int(),
		page_id: z.number().int(),
		name: z.string(),
		description: z.string(),
		preview: AssetRef.nullable(),
		sort_order: z.number().int(),
		created_at: z.number().int(),
	});
	export type Collection = z.infer<typeof Collection>;

	/** Model + texture of a cosmetic for one skin model. */
	export const Variant = z.object({
		id: z.number().int(),
		name: z.string(),
		skin_model: CatalogSettings.VariantSkinModel,
		model: AssetRef,
		texture: AssetRef,
		sort_order: z.number().int(),
	});
	export type Variant = z.infer<typeof Variant>;

	export const Product = z.object({
		id: z.number().int(),
		page_id: z.number().int(),
		collection_id: z.number().int().nullable(),
		type: CatalogSettings.ProductType,
		name: z.string(),
		description: z.string(),
		availability: CatalogSettings.ProductAvailability,
		listed: z.boolean(),
		texture: AssetRef.nullable().describe("Cape texture (capes only)"),
		preview: AssetRef.nullable(),
		variants: z.array(Variant).describe("Cosmetic variants (cosmetics only)"),
		sort_order: z.number().int(),
		published_at: z.number().int().nullable(),
		created_at: z.number().int(),
	});
	export type Product = z.infer<typeof Product>;

	/** A product as its page members and the moderators see it. */
	export const ManagedProduct = Product.extend({
		status: CatalogSettings.ProductStatus,
		review_note: z.string().nullable(),
		reviewed_at: z.number().int().nullable(),
		updated_at: z.number().int(),
		creator: PublicUser.nullable(),
	});
	export type ManagedProduct = z.infer<typeof ManagedProduct>;

	export const MinecraftAccount = z.object({
		uuid: z.string(),
		name: z.string(),
		skin_url: z
			.string()
			.nullable()
			.describe(
				"Mojang texture URL. Browsers load the skin through `<API>/skins/<uuid>.png` (with CORS).",
			),
		skin_model: MinecraftDataPolicies.SkinModel,
		uses_client: z.boolean().describe("Used the LeiCraftClient within the last 30 days"),
		linked_at: z.number().int().nullable(),
	});
	export type MinecraftAccount = z.infer<typeof MinecraftAccount>;

	/** Something in the user's wardrobe: an owned exclusive or a saved free product. */
	export const WardrobeItem = z.object({
		product: Product,
		page: z.object({
			id: z.number().int(),
			category: CatalogSettings.Category,
			slug: z.string(),
			name: z.string(),
		}),
		owned: z
			.boolean()
			.describe("Exclusive product the user owns (free products are usable without owning them)"),
		removable: z
			.boolean()
			.describe("Saved free product the user can remove; owned exclusives always stay"),
		added_at: z
			.number()
			.int()
			.describe("When the product was saved (or, for exclusives, when it was received)"),
	});
	export type WardrobeItem = z.infer<typeof WardrobeItem>;

	/** Whether one product is in the user's wardrobe. */
	export const WardrobeStatus = z.object({
		in_wardrobe: z.boolean(),
		owned: z.boolean().describe("Exclusive product the user owns — always in the wardrobe"),
		removable: z.boolean(),
	});
	export type WardrobeStatus = z.infer<typeof WardrobeStatus>;

	/** What a Minecraft account has equipped (owner view). */
	export const Loadout = z.object({
		cape: Product.nullable(),
		cosmetics: z.array(
			z.object({
				product: Product,
				variant_id: z
					.number()
					.int()
					.nullable()
					.describe("Pinned variant, or null to pick by the wearer's skin model"),
			}),
		),
	});
	export type Loadout = z.infer<typeof Loadout>;

	/**
	 * The public, render-ready profile of a player — what the mod and the website need to draw
	 * cape and cosmetics. For each cosmetic, pick `variant_id` if set; otherwise the first variant
	 * whose `skin_model` equals the wearer's skin model, then the first `any` variant, then the
	 * first variant.
	 */
	export const PlayerProfile = z.object({
		uuid: z.string(),
		name: z.string(),
		skin_model: MinecraftDataPolicies.SkinModel.describe(
			"Skin model from the last mod handshake — renderers that know the live skin should use that",
		),
		uses_client: z.boolean().describe("Used the LeiCraftClient within the last 30 days"),
		cape: z
			.object({
				product_id: z.number().int(),
				texture: AssetRef,
			})
			.nullable(),
		cosmetics: z.array(
			z.object({
				product_id: z.number().int(),
				variant_id: z.number().int().nullable(),
				variants: z.array(Variant),
			}),
		),
	});
	export type PlayerProfile = z.infer<typeof PlayerProfile>;
}
