import { randomUUID } from "node:crypto";
import type { DiscordOAuth } from "../../src/api/utils/discord";
import type { GitLabAPI } from "../../src/api/utils/gitlab";
import type { ModrinthAPI } from "../../src/api/utils/modrinth";

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
 * In-memory stand-in for the GitLab project the releases live on
 * (`LCC_GITLAB_API_BASE_URL=https://gitlab.test/api/v4`, project `1`): releases start without a
 * jar asset while their pipeline runs; a test completes one with `setRelease(tag, { jarURL })`
 * or fails it with `setRelease(tag, { pipeline: { status: "failed" } })`, playing what the real
 * tag pipeline does.
 */
export class FakeGitLab {
	protected static readonly releases = new Map<string, FakeGitLab.ReleaseState>();

	/** `POST /releases` calls the API made. */
	static readonly created: FakeGitLab.CreatedRelease[] = [];

	/** `PUT /releases/:tag` (release notes) calls the API made. */
	static readonly updatedNotes: Array<{ tag: string; description: string }> = [];

	static reset() {
		this.releases.clear();
		this.created.length = 0;
		this.updatedNotes.length = 0;
	}

	static setRelease(tag: string, state: Partial<FakeGitLab.ReleaseState> = {}) {
		this.releases.set(tag, {
			name: `LeiCraftClient ${tag}`,
			description: "",
			jarURL: null,
			pipeline: { status: "running", web_url: `https://gitlab.test/pipeline/${tag}` },
			...state,
		});
	}

	/** The package registry permalink the real release pipeline uploads the jar to. */
	static jarURL(version: string) {
		return `https://gitlab.test/api/v4/projects/1/packages/generic/leicraftclient/${version}/leicraftclient-${version}.jar`;
	}

	private static releaseJSON(tag: string, state: FakeGitLab.ReleaseState) {
		const version = tag.replace(/^v/, "");
		return {
			tag_name: tag,
			name: state.name,
			description: state.description,
			released_at: new Date().toISOString(),
			assets: {
				links: state.jarURL
					? [
							{
								id: 1,
								name: `leicraftclient-${version}.jar`,
								url: state.jarURL,
								direct_asset_url: state.jarURL,
								link_type: "package",
							},
						]
					: [],
			},
		};
	}

	static readonly fetcher: GitLabAPI.Fetcher = async (input, init) => {
		const url = new URL(input);

		const releaseTag = /^\/api\/v4\/projects\/1\/releases\/([^/]+)$/.exec(url.pathname)?.[1];

		if (url.pathname === "/api/v4/projects/1/releases" && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			if (FakeGitLab.releases.has(body.tag_name)) {
				return json({ message: "Release already exists" }, 409);
			}
			// like GitLab: a release of a tag that doesn't exist yet needs the ref to tag
			if (!body.ref) {
				return json({ message: "Ref is not specified" }, 422);
			}
			FakeGitLab.setRelease(body.tag_name);
			FakeGitLab.created.push({
				tag: body.tag_name,
				ref: body.ref,
				name: body.name,
				description: body.description,
			});
			return json(FakeGitLab.releaseJSON(body.tag_name, FakeGitLab.releases.get(body.tag_name)!));
		}

		if (url.pathname === "/api/v4/projects/1/releases") {
			const releases = [...FakeGitLab.releases.entries()].map(([tag, state]) =>
				FakeGitLab.releaseJSON(tag, state),
			);
			return json(releases.reverse());
		}

		if (releaseTag && init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			const state = FakeGitLab.releases.get(releaseTag);
			if (!state) return json({ message: "404 Release Not Found" }, 404);
			state.description = body.description;
			FakeGitLab.updatedNotes.push({ tag: releaseTag, description: body.description });
			return json(FakeGitLab.releaseJSON(releaseTag, state));
		}

		if (releaseTag) {
			const state = FakeGitLab.releases.get(releaseTag);
			return state
				? json(FakeGitLab.releaseJSON(releaseTag, state))
				: json({ message: "404 Release Not Found" }, 404);
		}

		const pipelinesMatch = url.pathname === "/api/v4/projects/1/pipelines";
		if (pipelinesMatch) {
			const state = FakeGitLab.releases.get(url.searchParams.get("ref") ?? "");
			return json(state?.pipeline ? [state.pipeline] : []);
		}

		if (url.pathname === "/api/v4/projects/1/repository/files/gradle.properties/raw") {
			return new Response(["minecraft_version=26.3", "loader_version=0.19.5"].join("\n"), {
				status: 200,
			});
		}

		return json({ message: "404 Not Found" }, 404);
	};
}

export namespace FakeGitLab {
	export interface ReleaseState {
		name: string;
		description: string;
		jarURL: string | null;
		pipeline: { status: string; web_url: string } | null;
	}

	export interface CreatedRelease {
		tag: string;
		ref: string;
		name: string;
		description: string;
	}
}

/**
 * In-memory stand-in for Modrinth (`LCC_MODRINTH_URL=https://modrinth.test/v2`): records what the
 * API publishes. It also answers the jar downloads from GitLab's package registry, because the
 * real API downloads the jar before uploading it.
 */
export class FakeModrinth {
	/** `POST /version` publishes the API made. */
	static readonly published: ModrinthPublish[] = [];

	/** Next publish attempts fail with this error (e.g. `"Version number already exists"`). */
	static failNext: string | null = null;

	static reset() {
		this.published.length = 0;
		this.failNext = null;
	}

	static readonly fetcher: ModrinthAPI.Fetcher = async (input, init) => {
		const url = new URL(input);

		// the jar the real pipeline uploaded (the API downloads it before uploading)
		if (url.hostname === "gitlab.test" && url.pathname.includes("/packages/generic/")) {
			return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 });
		}

		// the real API sends multipart form data: `data` (JSON) and the jar as `file`
		if (url.pathname.endsWith("/version") && init?.method === "POST") {
			if (FakeModrinth.failNext) {
				FakeModrinth.failNext = null;
				return json({ error: "Simulated Modrinth failure" }, 400);
			}

			const form = await new Request("https://modrinth.test/", {
				method: "POST",
				body: init.body as any,
				headers: init.headers as any,
			}).formData();
			const data = JSON.parse(String(form.get("data")));
			const filename = (form.get("file") as File | null)?.name ?? "";
			FakeModrinth.published.push({ ...data, filename });

			return json({
				id: `modrinth-${data.version_number}`,
				page_url: `https://modrinth.com/version/${data.version_number}`,
			});
		}

		if (url.pathname.endsWith("/project/leicraftclient/version")) {
			const number = url.searchParams.get("number");
			const existing = FakeModrinth.published.find((publish) => publish.version_number === number);
			return existing
				? json([{ id: `modrinth-${number}`, page_url: `https://modrinth.com/version/${number}` }])
				: json([]);
		}

		return json({ error: "not found" }, 404);
	};
}

interface ModrinthPublish {
	version_number: string;
	name: string;
	version_body: string;
	version_type: string;
	game_versions: string[];
	filename: string;
	[key: string]: unknown;
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
