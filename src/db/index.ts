import { mkdir as fs_mkdir } from "node:fs/promises";
import { dirname as path_dirname, join as path_join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Logger } from "../utils/logger";
import * as TableSchema from "./schema";
import { type DrizzleDB } from "./utils";

export class DB {
	protected static db: DrizzleDB.BunSQLite;

	static async init(
		path: string,
		autoMigrate: boolean,
		configBaseDir: string,
		migrationsFolder: string,
	) {
		await fs_mkdir(path_dirname(path), { recursive: true });
		await fs_mkdir(configBaseDir, { recursive: true });

		this.db = drizzle(path);

		this.db.$client.run("PRAGMA journal_mode = WAL;");
		this.db.$client.run("PRAGMA busy_timeout = 5000;");

		if (autoMigrate) {
			Logger.info("Running database migrations...");

			//@ts-ignore
			if (Bun?.isStandaloneExecutable) {
				// `bun build --compile --asset ./drizzle/migrations` embeds the files as `migrations/...`
				// next to the entry (`/$bunfs/root/migrations` on Linux) — without the `drizzle/` segment.
				migrationsFolder = path_join(import.meta.dir, "migrations");
			}

			await migrate(this.db, { migrationsFolder });

			Logger.info("Database migrations completed.");
		}

		// Enabled after the migrations: drizzle-kit rebuilds tables for some schema changes, which
		// would cascade-delete rows while foreign keys are enforced.
		this.db.$client.run("PRAGMA foreign_keys = ON;");

		// There is no initial admin user: accounts are created by the Discord login, and the
		// Discord IDs in LCC_ADMIN_DISCORD_IDS become admins when they log in.

		Logger.info(`Database initialized at ${path}`);
	}

	static instance() {
		if (!this.db) {
			throw new Error("Database not initialized. Call DB.init() first.");
		}
		return DB.db;
	}

	static async close() {
		if (!this.db) return;

		Logger.info("Database connection closed.");
		await this.db.$client.close();

		// `close()` calls sqlite3_close_v2, which defers releasing the OS file
		// handle until any unfinalized prepared statements are garbage collected.
		// Force that now so the underlying file is actually free (e.g. for tests
		// that remove the DB file/directory right after closing).
		Bun.gc(true);
		await Bun.sleep(500);
	}
}

export namespace DB.Tables {
	export const users = TableSchema.users;
	export const sessions = TableSchema.sessions;
	export const apiKeys = TableSchema.apiKeys;
	export const oauthStates = TableSchema.oauthStates;

	export const userPreferences = TableSchema.userPreferences;

	export const minecraftAccounts = TableSchema.minecraftAccounts;
	export const clientSessions = TableSchema.clientSessions;
	export const clientAuthChallenges = TableSchema.clientAuthChallenges;
	export const minecraftLinkCodes = TableSchema.minecraftLinkCodes;

	export const assets = TableSchema.assets;

	export const pages = TableSchema.pages;
	export const pageMembers = TableSchema.pageMembers;
	export const collections = TableSchema.collections;
	export const products = TableSchema.products;
	export const productVariants = TableSchema.productVariants;

	export const userItems = TableSchema.userItems;
	export const equippedCosmetics = TableSchema.equippedCosmetics;
	export const redeemCodes = TableSchema.redeemCodes;
	export const redeemCodeProducts = TableSchema.redeemCodeProducts;
	export const redeemCodeUses = TableSchema.redeemCodeUses;

	export const reports = TableSchema.reports;
	export const auditLogs = TableSchema.auditLogs;

	export const metadata = TableSchema.metadata;
}

export namespace DB.Models {
	export type User = typeof DB.Tables.users.$inferSelect;
	export type Session = typeof DB.Tables.sessions.$inferSelect;
	export type ApiKey = typeof DB.Tables.apiKeys.$inferSelect;
	export type OAuthState = typeof DB.Tables.oauthStates.$inferSelect;

	export type UserPreference = typeof DB.Tables.userPreferences.$inferSelect;

	export type MinecraftAccount = typeof DB.Tables.minecraftAccounts.$inferSelect;
	export type ClientSession = typeof DB.Tables.clientSessions.$inferSelect;
	export type ClientAuthChallenge = typeof DB.Tables.clientAuthChallenges.$inferSelect;
	export type MinecraftLinkCode = typeof DB.Tables.minecraftLinkCodes.$inferSelect;

	export type Asset = typeof DB.Tables.assets.$inferSelect;

	export type Page = typeof DB.Tables.pages.$inferSelect;
	export type PageMember = typeof DB.Tables.pageMembers.$inferSelect;
	export type Collection = typeof DB.Tables.collections.$inferSelect;
	export type Product = typeof DB.Tables.products.$inferSelect;
	export type ProductVariant = typeof DB.Tables.productVariants.$inferSelect;

	export type UserItem = typeof DB.Tables.userItems.$inferSelect;
	export type EquippedCosmetic = typeof DB.Tables.equippedCosmetics.$inferSelect;
	export type RedeemCode = typeof DB.Tables.redeemCodes.$inferSelect;
	export type RedeemCodeProduct = typeof DB.Tables.redeemCodeProducts.$inferSelect;
	export type RedeemCodeUse = typeof DB.Tables.redeemCodeUses.$inferSelect;

	export type Report = typeof DB.Tables.reports.$inferSelect;
	export type AuditLog = typeof DB.Tables.auditLogs.$inferSelect;

	export type Metadata = typeof DB.Tables.metadata.$inferSelect;
}
