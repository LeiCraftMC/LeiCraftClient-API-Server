import { z } from "zod";
import {
	CatalogSettings,
	ModerationSettings,
} from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace ModerationProductsModel {
	export const Entry = z.object({
		product: SharedViews.ManagedProduct,
		page: SharedViews.Page.extend({ status: CatalogSettings.PageStatus }),
	});
	export type Entry = z.infer<typeof Entry>;
}

export namespace ModerationProductsModel.GetAll {
	export const Query = z.object({
		status: CatalogSettings.ProductStatus.default("pending_review"),
		category: CatalogSettings.Category.optional(),
		page_id: z.coerce.number().int().positive().optional(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(ModerationProductsModel.Entry);
	export type Response = z.infer<typeof Response>;
}

export namespace ModerationProductsModel.ProductId {
	export const Params = z.object({
		productId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace ModerationProductsModel.Approve {
	export const Body = z.object({
		updated_at: z
			.number()
			.int()
			.describe(
				"The product's `updated_at` you reviewed — the approval fails if the product changed since",
			),
	});
	export type Body = z.infer<typeof Body>;
}

export namespace ModerationProductsModel.WithReason {
	export const Body = z.object({
		reason: ModerationSettings.Reason.describe("Shown to the page members"),
	});
	export type Body = z.infer<typeof Body>;
}
