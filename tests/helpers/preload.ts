import { afterAll, beforeAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { API } from "../../src/api";
import { AssetStore } from "../../src/api/utils/assets";
import { DiscordOAuth } from "../../src/api/utils/discord";
import { GitLabAPI } from "../../src/api/utils/gitlab";
import { ModrinthAPI } from "../../src/api/utils/modrinth";
import { MojangSessionService } from "../../src/api/utils/mojang";
import { DB } from "../../src/db";
import { ConfigHandler, type ENVConfigLike } from "../../src/utils/config";
import { FakeDiscord, FakeGitLab, FakeModrinth, FakeMojang, TEST_ADMIN_DISCORD_ID } from "./fakes";

function setTestEnv(rootDir: string) {
	const envVars = {
		LCC_LOG_LEVEL: "debug",

		LCC_API_HOST: "::",
		LCC_API_PORT: 12331,
		LCC_API_DISABLE_DOCS: false,

		LCC_DB_PATH: path.join(rootDir, "db.sqlite"),
		LCC_DB_AUTO_MIGRATE: true,
		LCC_DB_MIGRATION_DIR: "./drizzle/migrations",

		LCC_LOG_DIR: path.join(rootDir, "logs"),
		LCC_CONFIG_BASE_DIR: rootDir,

		LCC_APP_URL: "http://localhost:12332",

		LCC_API_PUBLIC_URL: "http://localhost:12331",
		LCC_API_TRUST_PROXY: false,

		LCC_ASSETS_DIR: path.join(rootDir, "assets"),

		LCC_DISCORD_CLIENT_ID: "100000000000000001",
		LCC_DISCORD_CLIENT_SECRET: "test-client-secret",
		LCC_DISCORD_REDIRECT_URI: "http://localhost:12332/auth/discord/callback",
		LCC_DISCORD_GUILD_ID: "100000000000000002",
		LCC_DISCORD_BOT_TOKEN: "test-bot-token",

		LCC_ADMIN_DISCORD_IDS: [TEST_ADMIN_DISCORD_ID],

		LCC_MOJANG_SESSION_SERVER_URL: "https://sessionserver.mojang.test",

		// No network in tests: GitLab and Modrinth are answered by in-memory fakes too.
		LCC_GITLAB_API_BASE_URL: "https://gitlab.test/api/v4",
		LCC_GITLAB_PROJECT_ID: "1",
		LCC_GITLAB_RELEASE_REF: "main",
		LCC_GITLAB_TOKEN: "test-gitlab-token",
		LCC_MODRINTH_URL: "https://modrinth.test/v2",
		LCC_MODRINTH_PROJECT_ID: "leicraftclient",
		LCC_MODRINTH_TOKEN: "test-modrinth-token",
	} as const satisfies ENVConfigLike;

	for (const [key, value] of Object.entries(envVars)) {
		process.env[key] = String(value);
	}
}

async function createIsolatedDataDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(process.cwd(), "tmp-data-"));
	return root;
}

/**
 * On Windows, file handles (e.g. the SQLite DB file) can take a moment to be
 * released after closing, making an immediate recursive removal flaky (EBUSY).
 * Retries manually since Bun's `fs.rm` doesn't reliably honor `maxRetries`/`retryDelay`.
 */
async function removeDirWithRetry(dir: string, attempts = 10, delayMs = 300) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		} catch (err: any) {
			if (
				attempt === attempts ||
				(err?.code !== "EBUSY" && err?.code !== "ENOTEMPTY" && err?.code !== "EPERM")
			) {
				console.error(`Failed to remove directory ${dir} on attempt ${attempt}:`, err);
			}
			await Bun.sleep(delayMs);
		}
	}
}

let TMP_ROOT: string | null = null;

beforeAll(async () => {
	TMP_ROOT = await createIsolatedDataDir();

	setTestEnv(TMP_ROOT);

	const config = await ConfigHandler.loadConfig();

	await DB.init(path.join(TMP_ROOT, "db.sqlite"), true, TMP_ROOT, "./drizzle/migrations");

	await AssetStore.init(config.ASSETS_DIR, config.API_PUBLIC_URL);

	// No network in tests: Discord, Mojang, GitLab and Modrinth are answered by in-memory fakes.
	DiscordOAuth.setFetcher(FakeDiscord.fetcher);
	MojangSessionService.setFetcher(FakeMojang.fetcher);
	GitLabAPI.setFetcher(FakeGitLab.fetcher);
	ModrinthAPI.setFetcher(FakeModrinth.fetcher);

	await API.init([config.APP_URL], false);

	await API.start(12331, "::");
});

afterAll(async () => {
	await API.stop();

	await DB.close();

	if (TMP_ROOT) {
		await removeDirWithRetry(TMP_ROOT);
	}
});
