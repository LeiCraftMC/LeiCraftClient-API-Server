import { z } from "zod";
import { CatalogSettings } from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace AccountInventoryModel.GetAll {
	export const Response = z.array(
		z.object({
			product: SharedViews.Product,
			source: CatalogSettings.ItemSource,
			available: z
				.boolean()
				.describe(
					"Whether the product can be equipped right now. Unavailable products come without files.",
				),
			created_at: z.number().int(),
		}),
	);
	export type Response = z.infer<typeof Response>;
}

export namespace AccountInventoryModel.Redeem {
	export const Body = z.object({
		code: z.string().trim().min(1).max(64),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = z.object({
		products: z.array(SharedViews.Product).describe("Every product the code grants"),
		granted_product_ids: z
			.array(z.number().int())
			.describe("Products that were newly added (the rest were already owned)"),
	});
	export type Response = z.infer<typeof Response>;
}
