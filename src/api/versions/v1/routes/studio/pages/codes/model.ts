import { z } from "zod";
import { CatalogSettings } from "../../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../../utils/shared-models/views";

export namespace StudioCodesModel {
	export const Code = z.object({
		id: z.number().int(),
		code: z.string(),
		page_id: z.number().int(),
		note: z.string(),
		max_uses: z.number().int().nullable().describe("null = unlimited"),
		use_count: z.number().int(),
		expires_at: z.number().int().nullable(),
		disabled: z.boolean(),
		usable: z.boolean().describe("Not disabled, not expired and uses left"),
		created_at: z.number().int(),
		created_by: SharedViews.PublicUser.nullable(),
		products: z.array(
			z.object({
				id: z.number().int(),
				name: z.string(),
				type: CatalogSettings.ProductType,
			}),
		),
	});
	export type Code = z.infer<typeof Code>;
}

export namespace StudioCodesModel.GetAll {
	export const Query = z.object({
		search: z.string().trim().min(1).max(64).optional().describe("Matches code and note"),
		limit: z.coerce.number().int().min(1).max(500).default(100),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(StudioCodesModel.Code);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioCodesModel.Create {
	export const MAX_BATCH = 500;

	export const Body = z
		.object({
			product_ids: z
				.array(z.number().int().positive())
				.min(1)
				.max(20)
				.describe("Exclusive products of this page the code grants"),
			code: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9-]{4,32}$/, "4–32 letters, digits or hyphens")
				.optional()
				.describe("A custom code like SUMMER2026 (case-insensitive). Omit to generate random codes."),
			count: z
				.number()
				.int()
				.min(1)
				.max(MAX_BATCH)
				.optional()
				.describe("How many random codes to generate (default 1)"),
			max_uses: z
				.number()
				.int()
				.positive()
				.nullable()
				.optional()
				.describe("Uses per code (default 1, null = unlimited)"),
			expires_at: z.number().int().positive().nullable().optional(),
			note: z.string().trim().max(200).optional(),
		})
		.refine((body) => body.code === undefined || (body.count ?? 1) === 1, {
			message: "A custom code can't be combined with count",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = z.array(StudioCodesModel.Code);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioCodesModel.CodeId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		codeId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioCodesModel.Update {
	export const Body = z
		.object({
			disabled: z.boolean().optional(),
			max_uses: z.number().int().positive().nullable().optional(),
			expires_at: z.number().int().positive().nullable().optional(),
			note: z.string().trim().max(200).optional(),
		})
		.refine((data) => Object.values(data).some((value) => value !== undefined), {
			message: "At least one field must be provided",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioCodesModel.Code;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioCodesModel.Redemptions {
	export const Response = z.array(
		z.object({
			user: SharedViews.PublicUser,
			created_at: z.number().int(),
		}),
	);
	export type Response = z.infer<typeof Response>;
}
