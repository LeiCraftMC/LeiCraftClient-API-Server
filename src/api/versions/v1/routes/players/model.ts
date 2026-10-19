import { z } from "zod";
import { MinecraftDataPolicies } from "../../../../utils/shared-models/accountData";
import { SharedViews } from "../../../../utils/shared-models/views";

export namespace PlayersModel.GetByUUID {
	export const Params = z.object({
		uuid: MinecraftDataPolicies.UUID,
	});
	export type Params = z.infer<typeof Params>;

	export const Response = SharedViews.PlayerProfile;
	export type Response = z.infer<typeof Response>;
}

export namespace PlayersModel.GetByName {
	export const Params = z.object({
		name: MinecraftDataPolicies.Name,
	});
	export type Params = z.infer<typeof Params>;

	export const Response = SharedViews.PlayerProfile;
	export type Response = z.infer<typeof Response>;
}

export namespace PlayersModel.Lookup {
	export const MAX_PLAYERS = 100;

	export const Body = z
		.object({
			uuids: z.array(MinecraftDataPolicies.UUID).max(MAX_PLAYERS).default([]),
			names: z
				.array(MinecraftDataPolicies.Name)
				.max(MAX_PLAYERS)
				.default([])
				.describe("Fallback for offline-mode servers: matched against the last verified name"),
		})
		.refine((body) => body.uuids.length + body.names.length <= MAX_PLAYERS, {
			message: `At most ${MAX_PLAYERS} players per request`,
		});
	export type Body = z.infer<typeof Body>;

	export const Response = z
		.array(SharedViews.PlayerProfile)
		.describe("Profiles of the requested players that have one; unknown players are omitted");
	export type Response = z.infer<typeof Response>;
}
