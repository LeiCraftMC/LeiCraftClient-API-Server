import { z } from "zod";
import { ModerationSettings } from "../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace ModerationUsersModel.GetAll {
	export const Query = z.object({
		search: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.optional()
			.describe("Display name, Discord username, Discord id or linked Minecraft name"),
		banned: z
			.enum(["true", "false"])
			.transform((value) => value === "true")
			.optional(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.ManagedUser);
	export type Response = z.infer<typeof Response>;
}

export namespace ModerationUsersModel.UserId {
	export const Params = z.object({
		userId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace ModerationUsersModel.Detail {
	export const Response = SharedViews.ManagedUser.extend({
		minecraft_accounts: z.array(SharedViews.MinecraftAccount),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ModerationUsersModel.Ban {
	export const Body = z.object({
		reason: ModerationSettings.Reason.describe("Shown to the user when they try to log in"),
		duration_days: z
			.number()
			.int()
			.min(1)
			.max(3650)
			.nullable()
			.optional()
			.describe("Omit or null for a permanent ban"),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.ManagedUser;
	export type Response = z.infer<typeof Response>;
}
