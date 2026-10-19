import { randomUUID } from "node:crypto";
import type { DiscordOAuth } from "../../src/api/utils/discord";

/** Discord id listed in LCC_ADMIN_DISCORD_IDS by the test preload. */
export const TEST_ADMIN_DISCORD_ID = "100000000000000099";

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * In-memory stand-in for the Discord API: `authorize(user)` plays the user clicking "Authorize"
 * and returns the `code` Discord would redirect back with.
 */
export class FakeDiscord {
	protected static readonly codes = new Map<string, DiscordOAuth.User>();
	protected static readonly tokens = new Map<string, DiscordOAuth.User>();

	/** Guild joins the API requested: `<guildID>:<userID>` */
	static readonly guildJoins: string[] = [];

	static authorize(user: Partial<DiscordOAuth.User> & { id: string }) {
		const code = `code_${randomUUID()}`;
		this.codes.set(code, {
			username: `discord_${user.id.slice(-6)}`,
			global_name: null,
			avatar: null,
			...user,
		});
		return code;
	}

	static readonly fetcher: DiscordOAuth.Fetcher = async (input, init) => {
		const url = new URL(input);

		if (url.pathname.endsWith("/oauth2/token") && init?.method === "POST") {
			const form = new URLSearchParams(String(init.body));
			const user = FakeDiscord.codes.get(form.get("code") ?? "");
			if (!user || form.get("grant_type") !== "authorization_code") {
				return json({ error: "invalid_grant" }, 400);
			}
			FakeDiscord.codes.delete(form.get("code") as string);

			const token = `token_${randomUUID()}`;
			FakeDiscord.tokens.set(token, user);
			return json({ access_token: token, token_type: "Bearer", expires_in: 604800 });
		}

		if (url.pathname.endsWith("/users/@me")) {
			const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
			const user = FakeDiscord.tokens.get(token);
			return user ? json(user) : json({ message: "401: Unauthorized" }, 401);
		}

		const guildJoin = /\/guilds\/(\d+)\/members\/(\d+)$/.exec(url.pathname);
		if (guildJoin && init?.method === "PUT") {
			FakeDiscord.guildJoins.push(`${guildJoin[1]}:${guildJoin[2]}`);
			return new Response(null, { status: 201 });
		}

		return json({ message: "404: Not Found" }, 404);
	};
}

/**
 * In-memory stand-in for Mojang's session server: `joinServer(...)` plays the game client
 * calling Mojang before the mod calls `/client/auth/verify`.
 */
export class FakeMojang {
	protected static readonly joins = new Map<
		string,
		{ uuid: string; name: string; skinModel: "wide" | "slim" }
	>();

	static joinServer(
		serverID: string,
		profile: { uuid: string; name: string; skinModel?: "wide" | "slim" },
	) {
		this.joins.set(serverID, { skinModel: "wide", ...profile });
	}

	static readonly fetcher = async (input: string) => {
		const url = new URL(input);
		if (!url.pathname.endsWith("/session/minecraft/hasJoined")) {
			return new Response(null, { status: 404 });
		}

		const join = FakeMojang.joins.get(url.searchParams.get("serverId") ?? "");
		if (!join || join.name.toLowerCase() !== url.searchParams.get("username")?.toLowerCase()) {
			return new Response(null, { status: 204 });
		}

		const textures = {
			timestamp: Date.now(),
			profileId: join.uuid.replaceAll("-", ""),
			profileName: join.name,
			textures: {
				SKIN: {
					url: `http://textures.minecraft.net/texture/${join.uuid.replaceAll("-", "")}`,
					...(join.skinModel === "slim" ? { metadata: { model: "slim" } } : {}),
				},
			},
		};

		return json({
			id: join.uuid.replaceAll("-", ""),
			name: join.name,
			properties: [
				{ name: "textures", value: Buffer.from(JSON.stringify(textures)).toString("base64") },
			],
		});
	};
}
