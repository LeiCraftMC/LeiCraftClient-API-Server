import { ConfigHandler } from "../../utils/config";
import { AppConstants } from "../../utils/constants";
import { Logger } from "../../utils/logger";

/**
 * Discord OAuth2 login — the same flow as LeiCraft Client V1 (authorization code grant, scopes
 * `identify guilds.join`, the user is added to the LeiCraftMC guild on login), plus a single-use
 * `state` against login CSRF. The website owns the redirect page and hands `code` + `state` to
 * `POST /v1/auth/discord/callback`; the Discord access token is used once and never stored.
 */
export class DiscordOAuth {
	static readonly AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
	static readonly API_BASE_URL = "https://discord.com/api/v10";
	static readonly CDN_BASE_URL = "https://cdn.discordapp.com";

	static readonly SCOPES = ["identify", "guilds.join"] as const;

	protected static readonly defaultFetcher: DiscordOAuth.Fetcher = (input, init) =>
		fetch(input, init);
	protected static fetcher: DiscordOAuth.Fetcher = DiscordOAuth.defaultFetcher;

	/** Replace the HTTP client (tests). `null` restores the real `fetch`. */
	static setFetcher(fetcher: DiscordOAuth.Fetcher | null) {
		this.fetcher = fetcher ?? this.defaultFetcher;
	}

	protected static getConfig() {
		const config = ConfigHandler.getConfig();
		if (!config) {
			throw new Error("Config not loaded. Call ConfigHandler.loadConfig() first.");
		}
		return config;
	}

	static getRedirectURI() {
		const config = this.getConfig();
		return (
			config.DISCORD_REDIRECT_URI ??
			`${config.APP_URL.replace(/\/+$/, "")}${AppConstants.WEBSITE_DISCORD_CALLBACK_PATH}`
		);
	}

	static buildAuthorizeURL(state: string) {
		const params = new URLSearchParams({
			client_id: this.getConfig().DISCORD_CLIENT_ID,
			response_type: "code",
			redirect_uri: this.getRedirectURI(),
			scope: this.SCOPES.join(" "),
			state,
			// skip the consent screen when the user already authorized these scopes
			prompt: "none",
		});
		return `${this.AUTHORIZE_URL}?${params.toString()}`;
	}

	/** Exchanges the authorization code for an access token, or null if Discord rejects it. */
	static async exchangeCode(code: string): Promise<string | null> {
		const config = this.getConfig();

		const res = await this.fetcher(`${this.API_BASE_URL}/oauth2/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${Buffer.from(`${config.DISCORD_CLIENT_ID}:${config.DISCORD_CLIENT_SECRET}`).toString("base64")}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: this.getRedirectURI(),
			}).toString(),
		});

		if (!res.ok) {
			Logger.debug(`Discord token exchange failed with status ${res.status}`);
			return null;
		}

		const body = (await res.json()) as { access_token?: unknown };
		return typeof body.access_token === "string" ? body.access_token : null;
	}

	static async fetchUser(accessToken: string): Promise<DiscordOAuth.User | null> {
		const res = await this.fetcher(`${this.API_BASE_URL}/users/@me`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (!res.ok) {
			Logger.debug(`Discord user lookup failed with status ${res.status}`);
			return null;
		}

		const body = (await res.json()) as Record<string, unknown>;
		if (typeof body.id !== "string" || typeof body.username !== "string") {
			return null;
		}

		return {
			id: body.id,
			username: body.username,
			global_name: typeof body.global_name === "string" ? body.global_name : null,
			avatar: typeof body.avatar === "string" ? body.avatar : null,
		};
	}

	/**
	 * Adds the user to the configured guild (V1 behaviour). Best effort: failures are logged and
	 * never block the login. Does nothing unless DISCORD_GUILD_ID and DISCORD_BOT_TOKEN are set.
	 */
	static async addToGuild(discordUserID: string, accessToken: string) {
		const config = this.getConfig();
		if (!config.DISCORD_GUILD_ID || !config.DISCORD_BOT_TOKEN) {
			return;
		}

		try {
			const res = await this.fetcher(
				`${this.API_BASE_URL}/guilds/${config.DISCORD_GUILD_ID}/members/${discordUserID}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
					},
					body: JSON.stringify({ access_token: accessToken }),
				},
			);

			// 201 = added, 204 = already a member
			if (res.status !== 201 && res.status !== 204) {
				Logger.warn(`Could not add Discord user ${discordUserID} to the guild (status ${res.status})`);
			}
		} catch (err) {
			Logger.warn(`Could not add Discord user ${discordUserID} to the guild:`, err);
		}
	}

	static getAvatarURL(discordID: string, avatarHash: string | null) {
		if (avatarHash) {
			return `${this.CDN_BASE_URL}/avatars/${discordID}/${avatarHash}.png`;
		}

		// Default avatar for accounts without one (new username system: (id >> 22) % 6)
		let index = 0;
		try {
			index = Number((BigInt(discordID) >> 22n) % 6n);
		} catch {
			// keep 0 for malformed ids
		}
		return `${this.CDN_BASE_URL}/embed/avatars/${index}.png`;
	}
}

export namespace DiscordOAuth {
	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	export interface User {
		id: string;
		username: string;
		global_name: string | null;
		avatar: string | null;
	}
}
