import { z } from "zod";
import { AppConstants } from "./constants";
import { Logger } from "./logger";

interface ConfigSchemaSettings {
	[key: string]: CS.ConfigItem<z.ZodType>;
}

type ConfigLike<T extends ConfigSchemaSettings> = {
	[K in keyof T]: z.infer<T[K]["_schema"]>;
};

class CS {
	private constructor() {}

	static string() {
		return new CS.ConfigItem(z.string());
	}

	static number() {
		return new CS.ConfigItem(z.coerce.number());
	}

	static boolean() {
		return new CS.ConfigItem(
			z.union(
				[
					z.boolean(),
					z
						.string()
						.refine((val) => val === "true" || val === "false")
						.transform((val) => val === "true"),
				],
				{ error: "Expected a boolean value ('true' or 'false')" },
			),
		);
	}

	static enum<const T extends readonly string[]>(values: T) {
		return new CS.ConfigItem(z.enum(values));
	}

	static array() {
		return new CS.ConfigItem(
			z.string().transform<string[]>((val) => {
				if (typeof val === "string") {
					return val
						.split(",")
						.map((v) => v.trim())
						.filter(Boolean);
				}
				return [];
			}),
		);
	}
}

namespace CS {
	export class ConfigItem<const Schema extends z.ZodType> {
		constructor(public _schema: Schema) {}

		public parse(value: unknown) {
			return this._schema.safeParse(value);
		}

		public default(value: z.util.NoUndefined<z.core.output<Schema>>) {
			this._schema = this._schema.default(value) as any;
			return this as any as ConfigItem<z.ZodDefault<Schema>>;
		}

		public optional() {
			this._schema = this._schema.optional() as any;
			return this as any as ConfigItem<z.ZodOptional<Schema>>;
		}
	}
}

class ConfigSchema<T extends ConfigSchemaSettings> {
	readonly schema: T;

	constructor(schema: T) {
		this.schema = schema;
	}

	public parse() {
		const result: ConfigLike<T> = {} as ConfigLike<T>;

		for (const [key, settings] of Object.entries(this.schema)) {
			const value = process.env[`${AppConstants.APP_ENV_PREFIX}_${key}`];

			const parseResult = settings.parse(value);
			if (!parseResult.success) {
				Logger.error(
					`Failed to read the environment variable ${key}: ${parseResult.error.issues[0]?.message}`,
				);
				process.exit(1);
			}

			// Store the parsed (coerced/defaulted) value, not the raw env string —
			// otherwise numbers/booleans stay strings and defaults/optionals are lost.
			(result[key] as any) = parseResult.data;
		}
		return result;
	}
}

export type ENVConfigLike = {
	[K in Extract<
		keyof typeof ConfigHandler.schema.schema,
		string
	> as `${typeof AppConstants.APP_ENV_PREFIX}_${K}`]: z.infer<
		(typeof ConfigHandler.schema.schema)[K]["_schema"]
	>;
};

export type ParsedConfig = ConfigLike<typeof ConfigHandler.schema.schema>;

export class ConfigHandler {
	// Public so ENVConfigLike / ParsedConfig can derive from it without @ts-ignore.
	// Treat it as read-only.
	static schema = new ConfigSchema({
		LOG_LEVEL: CS.enum(["debug", "info", "warn", "error", "critical"]).default("info"),

		API_HOST: CS.string().default("::"),
		API_PORT: CS.number().default(12331),
		API_DISABLE_DOCS: CS.boolean().default(false),

		DB_PATH: CS.string().default("./data/db.sqlite"),
		DB_AUTO_MIGRATE: CS.boolean().default(true),
		DB_MIGRATION_DIR: CS.string().default("./drizzle/migrations"),

		LOG_DIR: CS.string().default("./data/logs"),
		CONFIG_BASE_DIR: CS.string().default("./config"),

		// Website origin: CORS allowlist, Discord redirect and Minecraft link URLs
		APP_URL: CS.string(),

		// Public origin of this API, used for absolute asset URLs
		API_PUBLIC_URL: CS.string().default(`http://localhost:${AppConstants.APP_API_DEFAULT_PORT}`),
		// Read the client IP from X-Forwarded-For (only behind a trusted reverse proxy)
		API_TRUST_PROXY: CS.boolean().default(false),

		ASSETS_DIR: CS.string().default("./data/assets"),

		DISCORD_CLIENT_ID: CS.string(),
		DISCORD_CLIENT_SECRET: CS.string(),
		// Defaults to <APP_URL>/auth/discord/callback
		DISCORD_REDIRECT_URI: CS.string().optional(),
		// Users are added to this guild on login when both values are set (scope guilds.join)
		DISCORD_GUILD_ID: CS.string().optional(),
		DISCORD_BOT_TOKEN: CS.string().optional(),

		// Discord user IDs that are made admins when they log in (bootstrap, comma-separated)
		ADMIN_DISCORD_IDS: CS.array().default([]),

		MOJANG_SESSION_SERVER_URL: CS.string().default("https://sessionserver.mojang.com"),

		// The GitLab the mod's releases are built on (Releases API). A token is only needed for
		// creating/importing releases; the public endpoints work without one.
		GITLAB_API_BASE_URL: CS.string().default("https://git.leicraftmc.de/api/v4"),
		// Numeric id or URL-encoded path of the LeiCraftClient/Fabric project
		GITLAB_PROJECT_ID: CS.string().default("79"),
		// Personal access token with fine-grained scopes (see example.env); never sent to clients
		GITLAB_TOKEN: CS.string().optional(),

		// Modrinth auto-publish of released jars; optional — publishing fails when unset
		MODRINTH_URL: CS.string().default("https://api.modrinth.com/v2"),
		// Project id or slug of the LeiCraft Client project
		MODRINTH_PROJECT_ID: CS.string().default("leicraftclient"),
		// Modrinth token created on the project's page (scoped to that project); server-side only
		MODRINTH_TOKEN: CS.string().optional(),
	});

	private static config: ParsedConfig | null = null;

	/** You have to call {@link ConfigHandler.loadConfig} before trying to access the config. */
	static getConfig() {
		return this.config;
	}

	static async loadConfig() {
		if (this.config) return this.config;
		this.config = this.schema.parse();
		return this.config;
	}
}
