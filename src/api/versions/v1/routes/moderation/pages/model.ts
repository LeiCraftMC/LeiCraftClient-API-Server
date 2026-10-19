import { z } from "zod";
import {
	CatalogSettings,
	ModerationSettings,
} from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace ModerationPagesModel {
	/** A collection of a community page that is new or has pending changes. */
	export const CollectionToReview = SharedViews.Collection.extend({
		reviewed_at: z.number().int().nullable(),
		pending_changes: CatalogSettings.CollectionPendingChanges.nullable(),
	});
	export type CollectionToReview = z.infer<typeof CollectionToReview>;

	export const ModeratedPage = SharedViews.Page.extend({
		status: CatalogSettings.PageStatus,
		status_note: z.string().nullable(),
		owners: z.array(SharedViews.PublicUser),
		reviewed_at: z
			.number()
			.int()
			.nullable()
			.describe("Community pages: last profile approval (null = never approved, not public)"),
		review_requested_at: z.number().int().nullable(),
		pending_changes: CatalogSettings.PagePendingChanges.nullable(),
		review_note: z.string().nullable(),
		collections_to_review: z.array(CollectionToReview),
		updated_at: z.number().int(),
	});
	export type ModeratedPage = z.infer<typeof ModeratedPage>;
}

export namespace ModerationPagesModel.GetAll {
	export const Query = z.object({
		status: CatalogSettings.PageStatus.optional(),
		category: CatalogSettings.Category.optional(),
		search: z.string().trim().min(1).max(64).optional(),
		needs_review: z
			.enum(["true", "false"])
			.transform((value) => value === "true")
			.optional()
			.describe("`true`: the review queue of community page profiles, oldest request first"),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(ModerationPagesModel.ModeratedPage);
	export type Response = z.infer<typeof Response>;
}

export namespace ModerationPagesModel.PageId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace ModerationPagesModel.Approve {
	export const Body = z.object({
		updated_at: z
			.number()
			.int()
			.describe("The page's `updated_at` you reviewed — the approval fails if the page changed since"),
	});
	export type Body = z.infer<typeof Body>;
}

export namespace ModerationPagesModel.Reject {
	export const Body = z.object({
		reason: ModerationSettings.Reason.describe("Shown to the page owner"),
	});
	export type Body = z.infer<typeof Body>;
}

export namespace ModerationPagesModel.Hide {
	export const Body = z.object({
		reason: ModerationSettings.Reason.describe("Shown to the page members"),
	});
	export type Body = z.infer<typeof Body>;
}
