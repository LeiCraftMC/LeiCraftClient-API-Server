import { z } from "zod";
import { MinecraftDataPolicies } from "../../../../../utils/shared-models/accountData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace AccountMinecraftModel.GetAll {
	export const Response = z.array(SharedViews.MinecraftAccount);
	export type Response = z.infer<typeof Response>;
}

export namespace AccountMinecraftModel.LinkPreview {
	export const Params = z.object({
		code: z.string().min(1).max(128),
	});
	export type Params = z.infer<typeof Params>;

	export const Response = z.object({
		account: SharedViews.MinecraftAccount,
		expires_at: z.number().int(),
		linked_to_you: z.boolean(),
		linked_to_other_user: z.boolean(),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace AccountMinecraftModel.Link {
	export const Body = z.object({
		code: z.string().min(1).max(128).describe("Link code from the link the mod opened"),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.MinecraftAccount;
	export type Response = z.infer<typeof Response>;
}

export namespace AccountMinecraftModel.Account {
	export const Params = z.object({
		uuid: MinecraftDataPolicies.UUID,
	});
	export type Params = z.infer<typeof Params>;
}

export namespace AccountMinecraftModel.Loadout {
	export const Response = SharedViews.Loadout;
	export type Response = z.infer<typeof Response>;

	export const Body = z.object({
		cape_product_id: z.number().int().positive().nullable().describe("null = no cape"),
		cosmetics: z
			.array(
				z.object({
					product_id: z.number().int().positive(),
					variant_id: z
						.number()
						.int()
						.positive()
						.nullable()
						.optional()
						.describe("Pin a variant; omit or null to pick by the wearer's skin model"),
				}),
			)
			.max(10),
	});
	export type Body = z.infer<typeof Body>;
}
