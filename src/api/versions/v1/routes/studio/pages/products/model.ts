import { z } from "zod";
import {
	MinecraftDataPolicies,
	UserDataPolicies,
} from "../../../../../../utils/shared-models/accountData";
import { CatalogSettings } from "../../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../../utils/shared-models/views";

const Pagination = {
	limit: z.coerce.number().int().min(1).max(200).default(100),
	offset: z.coerce.number().int().min(0).default(0),
};

export namespace StudioProductsModel.GetAll {
	export const Query = z.object({
		status: CatalogSettings.ProductStatus.optional(),
		type: CatalogSettings.ProductType.optional(),
		collection_id: z.coerce.number().int().positive().optional(),
		search: z.string().trim().min(1).max(64).optional(),
		...Pagination,
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.ManagedProduct);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.Create {
	export const Body = z.object({
		type: CatalogSettings.ProductType,
		name: CatalogSettings.Name,
		description: CatalogSettings.Description.optional(),
		collection_id: z.number().int().positive().nullable().optional(),
		availability: CatalogSettings.ProductAvailability.optional().describe(
			"`exclusive` (only via redeem code or grant) is available on official and partner pages",
		),
		listed: z.boolean().optional().describe("Unlisted products are only reachable by id"),
		texture_asset_id: z
			.string()
			.nullable()
			.optional()
			.describe("Capes only: `cape_texture` asset (cosmetics use variants)"),
		preview_asset_id: z.string().nullable().optional().describe("`image` asset for the shop tile"),
		sort_order: z.number().int().optional(),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.ManagedProduct;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.ProductId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		productId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioProductsModel.Update {
	export const Body = StudioProductsModel.Create.Body.omit({ type: true })
		.partial()
		.refine((data) => Object.values(data).some((value) => value !== undefined), {
			message: "At least one field must be provided",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.ManagedProduct;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.Variants {
	export const Response = z.array(SharedViews.Variant);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.CreateVariant {
	export const Body = z.object({
		name: CatalogSettings.Name,
		skin_model: CatalogSettings.VariantSkinModel.optional().describe(
			"Which skin model this variant fits; `any` (default) fits both",
		),
		model_asset_id: z.string().describe("`cosmetic_model` asset"),
		texture_asset_id: z.string().describe("`cosmetic_texture` asset"),
		sort_order: z.number().int().optional(),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.Variant;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.VariantId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		productId: z.coerce.number().int().positive(),
		variantId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioProductsModel.UpdateVariant {
	export const Body = StudioProductsModel.CreateVariant.Body.partial().refine(
		(data) => Object.values(data).some((value) => value !== undefined),
		{ message: "At least one field must be provided" },
	);
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.Variant;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.Owners {
	export const Query = z.object(Pagination);
	export type Query = z.infer<typeof Query>;

	export const Owner = z.object({
		user: SharedViews.PublicUser,
		source: CatalogSettings.ItemSource,
		note: z.string().nullable(),
		granted_by: SharedViews.PublicUser.nullable(),
		redeem_code_id: z.number().int().nullable(),
		created_at: z.number().int(),
	});
	export type Owner = z.infer<typeof Owner>;

	export const Response = z.array(Owner);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.Grant {
	export const Body = z
		.object({
			user_id: z.number().int().positive().optional(),
			discord_id: UserDataPolicies.DiscordID.optional(),
			minecraft_uuid: MinecraftDataPolicies.UUID.optional(),
			minecraft_name: MinecraftDataPolicies.Name.optional().describe(
				"A Minecraft account linked to the user",
			),
			note: z.string().trim().max(200).optional(),
		})
		.refine(
			(body) =>
				[body.user_id, body.discord_id, body.minecraft_uuid, body.minecraft_name].filter(
					(value) => value !== undefined,
				).length === 1,
			{ message: "Provide exactly one of user_id, discord_id, minecraft_uuid or minecraft_name" },
		);
	export type Body = z.infer<typeof Body>;

	export const Response = StudioProductsModel.Owners.Owner;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioProductsModel.OwnerId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		productId: z.coerce.number().int().positive(),
		userId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}
