import z from "zod";

/**
 * Enums and policies of the catalog: categories → pages → collections → products (+ variants).
 * Used by the DB schema, the route models and the services so they can't drift.
 */
export namespace CatalogSettings {
	/**
	 * The three fixed shop categories:
	 * - `official`  — LeiCraft Client cosmetics made by the team (pages managed by admins + page members)
	 * - `partner`   — one page per partner, self-managed by its members without review
	 * - `community` — one page per user; every product is reviewed by a moderator before it goes live
	 */
	export const Categories = ["official", "partner", "community"] as const;
	export const Category = z.enum(Categories);
	export type Category = z.infer<typeof Category>;

	export const CategoryInfo = {
		official: {
			name: "LeiCraft Client",
			description: "Official capes and cosmetics made by the LeiCraft Client team.",
		},
		partner: {
			name: "Partners",
			description: "Capes and cosmetics from official LeiCraft Client partners.",
		},
		community: {
			name: "Community",
			description: "Capes and cosmetics created and uploaded by the community.",
		},
	} as const satisfies Record<Category, { name: string; description: string }>;

	/** Categories whose pages may hand out exclusive products via redeem codes and grants. */
	export function supportsExclusives(category: Category) {
		return category !== "community";
	}

	/** Categories whose products need a moderator review before they are published. */
	export function requiresReview(category: Category) {
		return category === "community";
	}

	export const PageStatuses = ["active", "hidden"] as const;
	export const PageStatus = z.enum(PageStatuses);
	export type PageStatus = z.infer<typeof PageStatus>;

	export const PageMemberRoles = ["owner", "manager"] as const;
	export const PageMemberRole = z.enum(PageMemberRoles);
	export type PageMemberRole = z.infer<typeof PageMemberRole>;

	export const ProductTypes = ["cape", "cosmetic"] as const;
	export const ProductType = z.enum(ProductTypes);
	export type ProductType = z.infer<typeof ProductType>;

	/**
	 * - `draft`          — being edited; invisible and not equippable
	 * - `pending_review` — community product waiting for a moderator
	 * - `published`      — live in the catalog and in-game
	 * - `rejected`       — a moderator rejected it (see `review_note`); editable, can be resubmitted
	 * - `disabled`       — taken down by a moderator; hidden everywhere until restored
	 */
	export const ProductStatuses = [
		"draft",
		"pending_review",
		"published",
		"rejected",
		"disabled",
	] as const;
	export const ProductStatus = z.enum(ProductStatuses);
	export type ProductStatus = z.infer<typeof ProductStatus>;

	/** `free` — anyone may equip it; `exclusive` — only users who own it (redeem code or grant). */
	export const ProductAvailabilities = ["free", "exclusive"] as const;
	export const ProductAvailability = z.enum(ProductAvailabilities);
	export type ProductAvailability = z.infer<typeof ProductAvailability>;

	/** Which player skin model a cosmetic variant is made for. `any` fits both. */
	export const VariantSkinModels = ["any", "wide", "slim"] as const;
	export const VariantSkinModel = z.enum(VariantSkinModels);
	export type VariantSkinModel = z.infer<typeof VariantSkinModel>;

	export const ItemSources = ["grant", "code"] as const;
	export const ItemSource = z.enum(ItemSources);
	export type ItemSource = z.infer<typeof ItemSource>;

	export const Slug = z
		.string()
		.min(3, "Must be at least 3 characters")
		.max(32, "Must be at most 32 characters")
		.regex(
			/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
			"Only lowercase letters, numbers and hyphens; must start and end with a letter or number",
		)
		.describe("URL-friendly identifier, unique within the category");

	export const Name = z.string().trim().min(1).max(64);
	export const Description = z.string().trim().max(2000);

	/**
	 * Edits of an already reviewed community page that wait for a moderator. The public catalog
	 * keeps showing the approved values until then.
	 */
	export const PagePendingChanges = z.object({
		slug: z.string().optional(),
		name: z.string().optional(),
		description: z.string().optional(),
		icon_asset_id: z.string().nullable().optional(),
		banner_asset_id: z.string().nullable().optional(),
	});
	export type PagePendingChanges = z.infer<typeof PagePendingChanges>;

	/** Same as {@link PagePendingChanges}, for collections of community pages. */
	export const CollectionPendingChanges = z.object({
		name: z.string().optional(),
		description: z.string().optional(),
		preview_asset_id: z.string().nullable().optional(),
	});
	export type CollectionPendingChanges = z.infer<typeof CollectionPendingChanges>;
}

export namespace ModerationSettings {
	export const ReportTargetTypes = ["product", "page", "collection", "user"] as const;
	export const ReportTargetType = z.enum(ReportTargetTypes);
	export type ReportTargetType = z.infer<typeof ReportTargetType>;

	export const ReportReasons = [
		"inappropriate",
		"copyright",
		"impersonation",
		"spam",
		"other",
	] as const;
	export const ReportReason = z.enum(ReportReasons);
	export type ReportReason = z.infer<typeof ReportReason>;

	export const ReportStatuses = ["open", "resolved", "dismissed"] as const;
	export const ReportStatus = z.enum(ReportStatuses);
	export type ReportStatus = z.infer<typeof ReportStatus>;

	export const Reason = z.string().trim().min(1).max(500);
}

export namespace AssetSettings {
	/**
	 * What an uploaded file is meant for. Each kind has its own validation:
	 * - `cape_texture`     — PNG, 2:1, width a multiple of 64 (64×32 … 2048×1024)
	 * - `cosmetic_model`   — OptiFine "PlayerItem" model JSON (.cfg, as exported by Blockbench)
	 * - `cosmetic_texture` — PNG, up to 1024×1024
	 * - `image`            — PNG for page icons/banners and previews, up to 2048×2048
	 */
	export const Kinds = ["cape_texture", "cosmetic_model", "cosmetic_texture", "image"] as const;
	export const Kind = z.enum(Kinds);
	export type Kind = z.infer<typeof Kind>;

	export const MimeTypes = ["image/png", "application/json"] as const;
	export const MimeType = z.enum(MimeTypes);
	export type MimeType = z.infer<typeof MimeType>;
}
