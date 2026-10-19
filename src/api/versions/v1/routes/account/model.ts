import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { DB } from "../../../../../db";

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
