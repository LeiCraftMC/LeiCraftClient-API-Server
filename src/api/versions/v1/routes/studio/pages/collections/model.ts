import { z } from "zod";
import { CatalogSettings } from "../../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../../utils/shared-models/views";

export namespace StudioCollectionsModel {
	export const StudioCollection = SharedViews.Collection.extend({
		product_count: z.number().int().describe("Products in the collection (any status)"),
		reviewed_at: z
			.number()
			.int()
			.nullable()
			.describe("Community pages: when a moderator approved it (null = not public yet)"),
		pending_changes: CatalogSettings.CollectionPendingChanges.nullable().describe(
			"Community pages: changes waiting for a moderator",
		),
		updated_at: z.number().int(),
	});
	export type StudioCollection = z.infer<typeof StudioCollection>;
}

export namespace StudioCollectionsModel.GetAll {
	export const Response = z.array(StudioCollectionsModel.StudioCollection);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioCollectionsModel.Create {
	export const Body = z.object({
		name: CatalogSettings.Name,
		description: CatalogSettings.Description.optional(),
		preview_asset_id: z.string().nullable().optional().describe("`image` asset"),
		sort_order: z.number().int().optional(),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioCollectionsModel.StudioCollection;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioCollectionsModel.CollectionId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		collectionId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioCollectionsModel.Update {
	export const Body = StudioCollectionsModel.Create.Body.partial().refine(
		(data) => Object.values(data).some((value) => value !== undefined),
		{ message: "At least one field must be provided" },
	);
	export type Body = z.infer<typeof Body>;

	export const Response = StudioCollectionsModel.StudioCollection;
	export type Response = z.infer<typeof Response>;
}
