import { z } from "zod";
import { UserDataPolicies } from "../../../../../../utils/shared-models/accountData";
import { CatalogSettings } from "../../../../../../utils/shared-models/catalogData";
import { SharedViews } from "../../../../../../utils/shared-models/views";

export namespace StudioMembersModel {
	export const Member = z.object({
		user: SharedViews.PublicUser,
		discord_username: z.string(),
		role: CatalogSettings.PageMemberRole,
		created_at: z.number().int(),
	});
	export type Member = z.infer<typeof Member>;
}

export namespace StudioMembersModel.GetAll {
	export const Response = z.array(StudioMembersModel.Member);
	export type Response = z.infer<typeof Response>;
}

export namespace StudioMembersModel.Add {
	export const Body = z
		.object({
			user_id: z.number().int().positive().optional(),
			discord_id: UserDataPolicies.DiscordID.optional(),
			role: CatalogSettings.PageMemberRole,
		})
		.refine((body) => (body.user_id === undefined) !== (body.discord_id === undefined), {
			message: "Provide exactly one of user_id or discord_id",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioMembersModel.Member;
	export type Response = z.infer<typeof Response>;
}

export namespace StudioMembersModel.MemberId {
	export const Params = z.object({
		pageId: z.coerce.number().int().positive(),
		userId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace StudioMembersModel.Update {
	export const Body = z.object({
		role: CatalogSettings.PageMemberRole,
	});
	export type Body = z.infer<typeof Body>;

	export const Response = StudioMembersModel.Member;
	export type Response = z.infer<typeof Response>;
}
