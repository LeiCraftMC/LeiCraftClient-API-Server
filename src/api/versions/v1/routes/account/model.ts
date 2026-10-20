import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { DB } from "../../../../../db";
import { SharedViews } from "../../../../utils/shared-models/views";
import { WardrobeHandler } from "../../../../utils/wardrobe";

export namespace AccountModel.GetInfo {
	export const Response = createSelectSchema(DB.Tables.users)
		.omit({
			discord_avatar_hash: true,
		})
		.extend({
			avatar_url: z.string(),
		});
	export type Response = z.infer<typeof Response>;
}

export namespace AccountModel.Wardrobe {
	export const Query = WardrobeHandler.Query;
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.WardrobeItem);
	export type Response = z.infer<typeof Response>;
}
