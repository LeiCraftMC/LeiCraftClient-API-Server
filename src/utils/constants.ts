export namespace AppConstants {
	export const APP_NAME = "LeiCraft Client";

	export const APP_ENV_PREFIX = "LCC";

	export const APP_KEYS_PREFIX = "lcc";

	export const APP_API_DEFAULT_PORT = 12550;

	export const APP_API_DEFAULT_PROD_URL = "https://api.client.leicraftmc.de";

	export const BINARY_NAME = "leicraft-client-api";

	/** Website path that consumes a Minecraft link code (`<APP_URL><path>?code=<code>`). */
	export const WEBSITE_MINECRAFT_LINK_PATH = "/link/minecraft";

	/** Website path Discord redirects to after the login (default redirect URI). */
	export const WEBSITE_DISCORD_CALLBACK_PATH = "/auth/discord/callback";
}
