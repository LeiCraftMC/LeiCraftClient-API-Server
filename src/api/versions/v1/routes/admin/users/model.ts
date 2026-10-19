import z from "zod";
import { UserAccountSettings } from "../../../../../utils/shared-models/accountData";
import { SharedViews } from "../../../../../utils/shared-models/views";

export namespace AdminUsersModel.GetAll {
	export const Query = z.object({
		role: UserAccountSettings.Role.optional(),
		search: z.string().trim().min(1).max(64).optional(),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.ManagedUser);
	export type Response = z.infer<typeof Response>;
}

export namespace AdminUsersModel.UserId {
	export const Params = z.object({
		userId: z.coerce.number().int().positive(),
	});
	export type Params = z.infer<typeof Params>;
}

export namespace AdminUsersModel.Update {
	export const Body = z.object({
		role: UserAccountSettings.Role,
	});
	export type Body = z.infer<typeof Body>;

	export const Response = SharedViews.ManagedUser;
	export type Response = z.infer<typeof Response>;
}
