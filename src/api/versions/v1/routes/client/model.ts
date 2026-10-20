import { z } from "zod";
import { MinecraftDataPolicies } from "../../../../utils/shared-models/accountData";
import { SharedViews } from "../../../../utils/shared-models/views";
import { WardrobeHandler } from "../../../../utils/wardrobe";

export namespace ClientModel.Challenge {
	export const Response = z.object({
		challenge_id: z.string(),
		server_id: z
			.string()
			.describe(
				"Pass this to Mojang's joinServer(profileId, accessToken, serverId) before calling /client/auth/verify",
			),
		expires_at: z.number().int(),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ClientModel.Verify {
	export const Body = z.object({
		challenge_id: z.string().min(1).max(128),
		username: MinecraftDataPolicies.Name,
	});
	export type Body = z.infer<typeof Body>;

	export const Response = z.object({
		token: z.string().describe("Client session token (Bearer) — valid for 7 days"),
		expires_at: z.number().int(),
		account: SharedViews.MinecraftAccount,
		user: SharedViews.PublicUser.nullable().describe("Linked LeiCraft user, if any"),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ClientModel.Session {
	export const Response = z.object({
		account: SharedViews.MinecraftAccount,
		user: SharedViews.PublicUser.nullable(),
		expires_at: z.number().int(),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ClientModel.LinkStatus {
	export const Response = z.object({
		linked: z.boolean(),
		user: SharedViews.PublicUser.nullable(),
		pending_code_expires_at: z
			.number()
			.int()
			.nullable()
			.describe("Expiry of the open link code, if one was created and not used yet"),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ClientModel.CreateLink {
	export const Response = z.object({
		code: z.string(),
		url: z.string().describe("Open this in the browser (clickable link in the mod)"),
		expires_at: z.number().int(),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace ClientModel.Wardrobe {
	export const Query = WardrobeHandler.Query;
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(SharedViews.WardrobeItem);
	export type Response = z.infer<typeof Response>;
}
