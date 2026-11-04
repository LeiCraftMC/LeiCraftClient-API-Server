import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { MinecraftDataPolicies, UserAccountSettings } from "../api/utils/shared-models/accountData";
import {
	AssetSettings,
	CatalogSettings,
	ModerationSettings,
} from "../api/utils/shared-models/catalogData";
import { ReleaseSettings } from "../api/utils/shared-models/releaseData";
import { SQLUtils } from "./utils";

// ─── Accounts & authentication ──────────────────────────────────────────────────────────────

/**
 * One row per LeiCraft account. Accounts are created on the first Discord login; there are no
 * passwords. A user can link several Minecraft accounts (see `minecraft_accounts`).
 *
 * @deprecated Use DB.Tables.users to access this table.
 */
export const users = sqliteTable("users", {
	id: SQLUtils.primaryKeyIntAutoIncrement("id"),

	discord_id: text().notNull().unique(),
	// Discord's unique username (refreshed on every login)
	discord_username: text().notNull(),
	// Discord global display name, falls back to the username
	display_name: text().notNull(),
	discord_avatar_hash: text(),

	role: text({
		enum: UserAccountSettings.Roles,
	})
		.default("user")
		.notNull(),

	// A user is banned while banned_at is set and banned_until is null (permanent) or in the future.
	banned_at: integer(),
	banned_until: integer(),
	ban_reason: text(),

	created_at: SQLUtils.getCreatedAtColumn(),
	last_login_at: integer(),
});

/**
 * @deprecated Use DB.Tables.sessions to access this table.
 */
export const sessions = sqliteTable("sessions", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	user_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	// we cache user role here for easier permission checking without having to join the users table, and we will check the role in users table on every update to make sure it's still valid
	user_role: text({
		enum: UserAccountSettings.Roles,
	}).notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * @deprecated Use DB.Tables.apiKeys to access this table.
 */
export const apiKeys = sqliteTable("api_keys", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	user_id: integer()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	// we cache user role here for easier permission checking without having to join the users table, and we will check the role in users table on every update to make sure it's still valid
	user_role: text({
		enum: UserAccountSettings.Roles,
	}).notNull(),
	description: text().notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer(),
});

/**
 * Pending Discord OAuth2 logins. The `state` parameter is stored only as its SHA3-256 hash and is
 * single-use (deleted by the callback). The `verifier` binds the login to the browser that
 * started it: the website keeps it (never in a URL) and sends it with the callback.
 *
 * @deprecated Use DB.Tables.oauthStates to access this table.
 */
export const oauthStates = sqliteTable("oauth_states", {
	state_hash: text().primaryKey(),
	verifier_hash: text().notNull(),
	// internal website path to return to after the login
	redirect_path: text(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * @deprecated Use DB.Tables.userPreferences to access this table.
 */
export const userPreferences = sqliteTable(
	"user_preferences",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		created_at: SQLUtils.getCreatedAtColumn(),

		// Preference key, e.g. "onboarding".
		key: text().notNull(),
		data: text({ mode: "json" }).$type<Record<string, any> | Array<any>>().notNull(),
	},
	(table) => [uniqueIndex("user_preferences_user_id_key_unique").on(table.user_id, table.key)],
);

// ─── Minecraft accounts & the mod (client) ──────────────────────────────────────────────────

/**
 * A Minecraft account that proved ownership through the mod (Mojang session `hasJoined` check).
 * It may or may not be linked to a LeiCraft user. The equipped cape lives here; equipped
 * cosmetics live in `equipped_cosmetics` — so every linked Minecraft account has its own loadout.
 *
 * @deprecated Use DB.Tables.minecraftAccounts to access this table.
 */
export const minecraftAccounts = sqliteTable(
	"minecraft_accounts",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),

		// dashed, lowercase
		uuid: text().notNull().unique(),
		// last name confirmed by Mojang
		name: text().notNull(),

		user_id: integer().references(() => users.id, { onDelete: "set null" }),
		linked_at: integer(),

		skin_url: text(),
		skin_model: text({ enum: MinecraftDataPolicies.SkinModels }).default("wide").notNull(),

		cape_product_id: integer().references(() => products.id, { onDelete: "set null" }),

		// last authenticated activity of the LeiCraft Client (mod) for this account
		last_seen_at: integer(),

		created_at: SQLUtils.getCreatedAtColumn(),
		updated_at: SQLUtils.getCreatedAtColumn("updated_at"),
	},
	(table) => [
		index("minecraft_accounts_user_id_idx").on(table.user_id),
		index("minecraft_accounts_name_idx").on(sql`lower(${table.name})`),
	],
);

/**
 * Bearer sessions of the mod (`lcc_client_<id>:<base>`), bound to one Minecraft account.
 *
 * @deprecated Use DB.Tables.clientSessions to access this table.
 */
export const clientSessions = sqliteTable("client_sessions", {
	id: text().primaryKey(),
	hashed_token: text().notNull(),
	minecraft_account_id: integer()
		.notNull()
		.references(() => minecraftAccounts.id, { onDelete: "cascade" }),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * Short-lived server IDs handed to the mod for the Mojang `joinServer` / `hasJoined` handshake.
 *
 * @deprecated Use DB.Tables.clientAuthChallenges to access this table.
 */
export const clientAuthChallenges = sqliteTable("client_auth_challenges", {
	id: text().primaryKey(),
	server_id: text().notNull(),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

/**
 * One-time codes behind the clickable link the mod shows to link a Minecraft account to a
 * LeiCraft (Discord) account. Stored only as SHA3-256 hash.
 *
 * @deprecated Use DB.Tables.minecraftLinkCodes to access this table.
 */
export const minecraftLinkCodes = sqliteTable("minecraft_link_codes", {
	code_hash: text().primaryKey(),
	minecraft_account_id: integer()
		.notNull()
		.references(() => minecraftAccounts.id, { onDelete: "cascade" }),
	created_at: SQLUtils.getCreatedAtColumn(),
	expires_at: integer().notNull(),
});

// ─── Assets ────────────────────────────────────────────────────────────────────────────────

/**
 * Uploaded files, content-addressed: the id is the SHA-256 of the stored bytes, the file lives
 * at `<ASSETS_DIR>/<id[0..2]>/<id>` and is served immutable at `/assets/<id>.<png|json>`.
 *
 * @deprecated Use DB.Tables.assets to access this table.
 */
export const assets = sqliteTable("assets", {
	id: text().primaryKey(),
	mime_type: text({ enum: AssetSettings.MimeTypes }).notNull(),
	size: integer().notNull(),
	width: integer(),
	height: integer(),
	uploaded_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
	created_at: SQLUtils.getCreatedAtColumn(),
});

// ─── Catalog: categories → pages → collections → products ──────────────────────────────────

/**
 * A shop page inside one of the fixed categories (official / partner / community).
 *
 * @deprecated Use DB.Tables.pages to access this table.
 */
export const pages = sqliteTable(
	"pages",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),

		category: text({ enum: CatalogSettings.Categories }).notNull(),
		slug: text().notNull(),
		name: text().notNull(),
		description: text().notNull().default(""),

		icon_asset_id: text().references(() => assets.id, { onDelete: "set null" }),
		banner_asset_id: text().references(() => assets.id, { onDelete: "set null" }),

		status: text({ enum: CatalogSettings.PageStatuses }).notNull().default("active"),
		// why a moderator hid the page
		status_note: text(),

		// Community pages only: when a moderator last approved the profile (name, slug,
		// description, icon, banner, collections). Never approved = not public.
		reviewed_at: integer(),
		// edits of a reviewed community page waiting for a moderator
		pending_changes: text({ mode: "json" }).$type<CatalogSettings.PagePendingChanges>(),
		// why the last profile changes were rejected
		review_note: text(),
		// set when the creator changed the profile or a collection; cleared by approve / reject
		review_requested_at: integer(),

		sort_order: integer().notNull().default(0),

		created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		created_at: SQLUtils.getCreatedAtColumn(),
		updated_at: SQLUtils.getCreatedAtColumn("updated_at"),
	},
	(table) => [
		uniqueIndex("pages_category_slug_unique").on(table.category, table.slug),
		// the official category is one page, not a list
		uniqueIndex("pages_single_official_unique")
			.on(table.category)
			.where(sql`${table.category} = 'official'`),
	],
);

/**
 * Who may manage a page in the studio. Community pages have exactly one owner.
 *
 * @deprecated Use DB.Tables.pageMembers to access this table.
 */
export const pageMembers = sqliteTable(
	"page_members",
	{
		page_id: integer()
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text({ enum: CatalogSettings.PageMemberRoles }).notNull(),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [
		primaryKey({ columns: [table.page_id, table.user_id] }),
		index("page_members_user_id_idx").on(table.user_id),
	],
);

/**
 * A group of products on a page (called "packages" in V1).
 *
 * @deprecated Use DB.Tables.collections to access this table.
 */
export const collections = sqliteTable(
	"collections",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		page_id: integer()
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),

		name: text().notNull(),
		description: text().notNull().default(""),
		preview_asset_id: text().references(() => assets.id, { onDelete: "set null" }),
		sort_order: integer().notNull().default(0),

		// Community pages only, reviewed together with the page profile (see `pages`)
		reviewed_at: integer(),
		pending_changes: text({ mode: "json" }).$type<CatalogSettings.CollectionPendingChanges>(),

		created_at: SQLUtils.getCreatedAtColumn(),
		updated_at: SQLUtils.getCreatedAtColumn("updated_at"),
	},
	(table) => [index("collections_page_id_idx").on(table.page_id)],
);

/**
 * A cape or a cosmetic. Capes carry their texture directly; cosmetics have one or more
 * variants (`product_variants`) with model + texture each.
 *
 * @deprecated Use DB.Tables.products to access this table.
 */
export const products = sqliteTable(
	"products",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		page_id: integer()
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),
		collection_id: integer().references(() => collections.id, { onDelete: "set null" }),

		type: text({ enum: CatalogSettings.ProductTypes }).notNull(),
		name: text().notNull(),
		description: text().notNull().default(""),

		status: text({ enum: CatalogSettings.ProductStatuses }).notNull().default("draft"),
		// what `restore` returns a disabled product to (content can't change while disabled)
		status_before_disable: text({ enum: CatalogSettings.ProductStatuses }),
		availability: text({ enum: CatalogSettings.ProductAvailabilities }).notNull().default("free"),
		// unlisted products are reachable by id but not shown in catalog listings
		listed: integer({ mode: "boolean" }).notNull().default(true),

		// capes only
		texture_asset_id: text().references(() => assets.id, { onDelete: "set null" }),
		preview_asset_id: text().references(() => assets.id, { onDelete: "set null" }),

		creator_user_id: integer().references(() => users.id, { onDelete: "set null" }),

		// rejection / takedown reason, visible to the page members
		review_note: text(),
		reviewed_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		reviewed_at: integer(),
		published_at: integer(),

		sort_order: integer().notNull().default(0),

		created_at: SQLUtils.getCreatedAtColumn(),
		updated_at: SQLUtils.getCreatedAtColumn("updated_at"),
	},
	(table) => [
		index("products_page_id_idx").on(table.page_id),
		index("products_collection_id_idx").on(table.collection_id),
		index("products_status_idx").on(table.status),
	],
);

/**
 * Model + texture of a cosmetic for a skin model (e.g. a separate fit for slim arms).
 *
 * @deprecated Use DB.Tables.productVariants to access this table.
 */
export const productVariants = sqliteTable(
	"product_variants",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		product_id: integer()
			.notNull()
			.references(() => products.id, { onDelete: "cascade" }),

		name: text().notNull(),
		skin_model: text({ enum: CatalogSettings.VariantSkinModels }).notNull().default("any"),

		model_asset_id: text()
			.notNull()
			.references(() => assets.id),
		texture_asset_id: text()
			.notNull()
			.references(() => assets.id),

		sort_order: integer().notNull().default(0),

		created_at: SQLUtils.getCreatedAtColumn(),
		updated_at: SQLUtils.getCreatedAtColumn("updated_at"),
	},
	(table) => [index("product_variants_product_id_idx").on(table.product_id)],
);

// ─── Ownership, loadouts & codes ────────────────────────────────────────────────────────────

/**
 * Exclusive products a user owns (free products need no row).
 *
 * @deprecated Use DB.Tables.userItems to access this table.
 */
export const userItems = sqliteTable(
	"user_items",
	{
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		product_id: integer()
			.notNull()
			.references(() => products.id, { onDelete: "cascade" }),

		source: text({ enum: CatalogSettings.ItemSources }).notNull(),
		granted_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		redeem_code_id: integer().references(() => redeemCodes.id, { onDelete: "set null" }),
		note: text(),

		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [
		primaryKey({ columns: [table.user_id, table.product_id] }),
		index("user_items_product_id_idx").on(table.product_id),
	],
);

/**
 * Cosmetics equipped on a Minecraft account. `variant_id` null means "pick automatically by the
 * wearer's skin model".
 *
 * @deprecated Use DB.Tables.equippedCosmetics to access this table.
 */
export const equippedCosmetics = sqliteTable(
	"equipped_cosmetics",
	{
		minecraft_account_id: integer()
			.notNull()
			.references(() => minecraftAccounts.id, { onDelete: "cascade" }),
		product_id: integer()
			.notNull()
			.references(() => products.id, { onDelete: "cascade" }),
		variant_id: integer().references(() => productVariants.id, { onDelete: "set null" }),
		position: integer().notNull().default(0),
	},
	(table) => [
		primaryKey({ columns: [table.minecraft_account_id, table.product_id] }),
		index("equipped_cosmetics_product_id_idx").on(table.product_id),
	],
);

/**
 * Redeem codes issued by an official or partner page. Each code grants one or more products of
 * that page (`redeem_code_products`).
 *
 * @deprecated Use DB.Tables.redeemCodes to access this table.
 */
export const redeemCodes = sqliteTable(
	"redeem_codes",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		// normalized: uppercase
		code: text().notNull().unique(),
		page_id: integer()
			.notNull()
			.references(() => pages.id, { onDelete: "cascade" }),

		note: text().notNull().default(""),
		// null = unlimited
		max_uses: integer(),
		use_count: integer().notNull().default(0),
		expires_at: integer(),
		disabled: integer({ mode: "boolean" }).notNull().default(false),

		created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [index("redeem_codes_page_id_idx").on(table.page_id)],
);

/**
 * @deprecated Use DB.Tables.redeemCodeProducts to access this table.
 */
export const redeemCodeProducts = sqliteTable(
	"redeem_code_products",
	{
		code_id: integer()
			.notNull()
			.references(() => redeemCodes.id, { onDelete: "cascade" }),
		product_id: integer()
			.notNull()
			.references(() => products.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.code_id, table.product_id] })],
);

/**
 * @deprecated Use DB.Tables.redeemCodeUses to access this table.
 */
export const redeemCodeUses = sqliteTable(
	"redeem_code_uses",
	{
		code_id: integer()
			.notNull()
			.references(() => redeemCodes.id, { onDelete: "cascade" }),
		user_id: integer()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [primaryKey({ columns: [table.code_id, table.user_id] })],
);

// ─── Moderation ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use DB.Tables.reports to access this table.
 */
export const reports = sqliteTable(
	"reports",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		reporter_user_id: integer().references(() => users.id, { onDelete: "set null" }),

		target_type: text({ enum: ModerationSettings.ReportTargetTypes }).notNull(),
		target_id: integer().notNull(),
		reason: text({ enum: ModerationSettings.ReportReasons }).notNull(),
		details: text().notNull().default(""),

		status: text({ enum: ModerationSettings.ReportStatuses }).notNull().default("open"),
		resolved_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		resolution_note: text(),
		resolved_at: integer(),

		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [
		index("reports_status_idx").on(table.status),
		index("reports_target_idx").on(table.target_type, table.target_id),
	],
);

/**
 * Who did what: moderation, administration and studio actions on shared content.
 *
 * @deprecated Use DB.Tables.auditLogs to access this table.
 */
export const auditLogs = sqliteTable(
	"audit_logs",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),
		actor_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		action: text().notNull(),
		target_type: text().notNull(),
		target_id: text(),
		details: text({ mode: "json" }).$type<Record<string, any>>().notNull().default({}),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [
		index("audit_logs_actor_idx").on(table.actor_user_id),
		index("audit_logs_target_idx").on(table.target_type, table.target_id),
	],
);

// ─── Mod releases ────────────────────────────────────────────────────────────────────────────

/**
 * A release of the LeiCraft Client Fabric mod, created on the admin dashboard: either a new GitLab
 * release was triggered (tag + build pipeline attach the jar asset) or an existing GitLab release
 * was imported. `download_url` is set once the pipeline finished and the jar asset link appeared;
 * only then the release is `published` and served publicly. The Modrinth auto-publish is tracked
 * separately (`modrinth_state`) — it may fail while the release itself is published.
 *
 * @deprecated Use DB.Tables.releases to access this table.
 */
export const releases = sqliteTable(
	"releases",
	{
		id: SQLUtils.primaryKeyIntAutoIncrement("id"),

		// mod version without the leading "v" of the GitLab tag, e.g. "2.0.0-pre.5"
		version: text().notNull().unique(),
		title: text().notNull(),
		changelog: text().notNull(),

		status: text({ enum: ReleaseSettings.Statuses }).notNull().default("pending"),
		// GitLab package registry permalink of the jar, set once the build finished
		download_url: text(),
		// pipeline of the tag build (why it failed, build logs)
		pipeline_url: text(),
		// why the release failed (pipeline failed or the build never finished)
		error_message: text(),

		// independent of the build: skipped when auto-publish was not requested
		modrinth_state: text({ enum: ReleaseSettings.ModrinthStates }).notNull().default("skipped"),
		modrinth_url: text(),
		modrinth_error: text(),

		published_at: integer(),
		created_by_user_id: integer().references(() => users.id, { onDelete: "set null" }),
		created_at: SQLUtils.getCreatedAtColumn(),
	},
	(table) => [index("releases_status_idx").on(table.status)],
);

// ─── Runtime metadata ───────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use DB.Tables.metadata to access this table.
 */
export const metadata = sqliteTable("metadata", {
	key: text().primaryKey(),
	data: text({ mode: "json" }).$type<Record<string, any> | Array<any>>().notNull(),
});
