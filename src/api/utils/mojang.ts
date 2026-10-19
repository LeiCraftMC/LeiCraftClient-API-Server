import { ConfigHandler } from "../../utils/config";
import { Logger } from "../../utils/logger";
import { MinecraftDataPolicies } from "./shared-models/accountData";

/**
 * Proof of Minecraft account ownership, the same way a Minecraft server does it:
 * the mod calls Mojang's `joinServer(profile, accessToken, serverId)` with a server ID this API
 * handed out, then the API asks the session server `hasJoined(username, serverId)`. Mojang only
 * confirms when the real account owner joined — the access token never leaves the game.
 */
export class MojangSessionService {
	protected static readonly defaultFetcher: MojangSessionService.Fetcher = (input, init) =>
		fetch(input, init);
	protected static fetcher: MojangSessionService.Fetcher = MojangSessionService.defaultFetcher;

	/** Replace the HTTP client (tests). `null` restores the real `fetch`. */
	static setFetcher(fetcher: MojangSessionService.Fetcher | null) {
		this.fetcher = fetcher ?? this.defaultFetcher;
	}

	/**
	 * Returns the verified profile, or null when Mojang does not confirm the join.
	 * Throws when the session server is unreachable or answers unexpectedly.
	 */
	static async hasJoined(username: string, serverID: string) {
		const baseURL = (
			ConfigHandler.getConfig()?.MOJANG_SESSION_SERVER_URL ?? "https://sessionserver.mojang.com"
		).replace(/\/+$/, "");

		const params = new URLSearchParams({ username, serverId: serverID });
		const res = await this.fetcher(`${baseURL}/session/minecraft/hasJoined?${params.toString()}`);

		if (res.status === 204 || res.status === 404 || res.status === 403) {
			return null;
		}
		if (!res.ok) {
			throw new Error(`Mojang session server answered with status ${res.status}`);
		}

		const body = (await res.json()) as {
			id?: unknown;
			name?: unknown;
			properties?: Array<{ name?: unknown; value?: unknown }>;
		};

		const uuid = typeof body.id === "string" ? MinecraftDataPolicies.normalizeUUID(body.id) : null;
		if (!uuid || typeof body.name !== "string") {
			throw new Error("Mojang session server returned an invalid profile");
		}

		return {
			uuid,
			name: body.name,
			...this.decodeTextures(body.properties ?? []),
		} satisfies MojangSessionService.Profile;
	}

	protected static decodeTextures(properties: Array<{ name?: unknown; value?: unknown }>) {
		const result: Pick<MojangSessionService.Profile, "skin_url" | "skin_model"> = {
			skin_url: null,
			skin_model: "wide",
		};

		const textures = properties.find((property) => property.name === "textures");
		if (typeof textures?.value !== "string") {
			return result;
		}

		try {
			const decoded = JSON.parse(Buffer.from(textures.value, "base64").toString("utf-8")) as {
				textures?: { SKIN?: { url?: unknown; metadata?: { model?: unknown } } };
			};
			const skin = decoded.textures?.SKIN;
			if (typeof skin?.url === "string") {
				result.skin_url = skin.url.replace(/^http:\/\//, "https://");
			}
			if (skin?.metadata?.model === "slim") {
				result.skin_model = "slim";
			}
		} catch (err) {
			Logger.debug("Could not decode Mojang textures property:", err);
		}

		return result;
	}
}

export namespace MojangSessionService {
	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	export interface Profile {
		uuid: string;
		name: string;
		skin_url: string | null;
		skin_model: MinecraftDataPolicies.SkinModel;
	}
}
