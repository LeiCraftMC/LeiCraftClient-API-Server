import { z } from "zod";
import { CatalogSettings } from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace StudioPagesModel {
	export const StudioPage = SharedViews.Page.extend({
		status: CatalogSettings.PageStatus,
		status_note: z.string().nullable().describe("Why a moderator hid the page"),
		member_role: CatalogSettings.PageMemberRole.nullable().describe(
			"Your role on the page (null for admins acting without membership)",
		),
		reviewed_at: z
			.number()
			.int()
			.nullable()
			.describe("Community pages: when a moderator last approved the profile (null = not public yet)"),
		review_requested_at: z
			.number()
			.int()
			.nullable()
			.describe("Community pages: set while changes wait for a moderator"),
		pending_changes: CatalogSettings.PagePendingChanges.nullable().describe(
			"Community pages: profile changes waiting for a moderator",
		),
		review_note: z.string().nullable().describe("Why the last profile changes were rejected"),
		updated_at: z.number().int(),
	});
	export type StudioPage = z.infer<typeof StudioPage>;
}

export namespace StudioPagesModel.GetAll {
	export const Query = z.object({
		category: CatalogSettings.Category.optional(),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(StudioPagesModel.StudioPage);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioPagesModel.Create {
	export const Body = z.object({
		category: CatalogSettings.Category.describe(
			"Users can create one `community` page; admins can create pages in every category",
		),
		slug: CatalogSettings.Slug,
		name: CatalogSettings.Name,
		description: CatalogSettings.Description.optional(),
		owner_user_id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Admins only: make this user the page owner (default: yourself for community pages)"),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioPagesModel.StudioPage;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioPagesModel.PageId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioPagesModel.Update {
	export const Body = z
		.object({
			slug: CatalogSettings.Slug.optional(),
			name: CatalogSettings.Name.optional(),
			description: CatalogSettings.Description.optional(),
			icon_asset_id: z.string().nullable().optional().describe("`image` asset"),
			banner_asset_id: z.string().nullable().optional().describe("`image` asset"),
			sort_order: z.number().int().optional().describe("Admins only"),
		})
		.refine((data) => Object.values(data).some((value) => value !== undefined), {
			message: "At least one field must be provided",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioPagesModel.StudioPage;
	export type Response = z.infer<typeof Response>;
}
