import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { ConfigHandler } from "../../utils/config";
import { AppConstants } from "../../utils/constants";
import { LCrypt } from "../../utils/crypto/lcrypt";
import type { MojangSessionService } from "./mojang";
import type { SharedViews } from "./shared-models/views";

/**
 * Minecraft accounts verified through the mod, and linking them to LeiCraft (Discord) users.
 *
 * Linking flow: the mod creates a one-time link code (`POST /v1/client/link`) and shows it as a
 * clickable link to `<APP_URL>/link/minecraft?code=<code>`. The website shows the account
 * (`GET /v1/account/minecraft/link/:code`) and the logged-in user confirms
 * (`POST /v1/account/minecraft/link`). Codes live 10 minutes and are stored hashed.
 */
export class MinecraftAccountHandler {
	static readonly LINK_CODE_LIFETIME_MS = 10 * 60 * 1000;
	static readonly MAX_ACCOUNTS_PER_USER = 5;

	/** A player counts as LeiCraft Client user when the mod was used within this window. */
	static readonly USES_CLIENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
	/** `last_seen_at` is written at most this often per account. */
	static readonly LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

	static async getByID(accountID: number, tx: DrizzleDB = DB.instance()) {
		return await tx
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.id, accountID))
			.get();
	}

	/** `uuid` must already be normalized (dashed, lowercase). */
	static async getByUUID(uuid: string, tx: DrizzleDB = DB.instance()) {
		return await tx
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.uuid, uuid))
			.get();
	}

	/** The account that most recently used the name (names can move between accounts). */
	static async getByName(name: string, tx: DrizzleDB = DB.instance()) {
		return await tx
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(sql`lower(${DB.Tables.minecraftAccounts.name}) = ${name.toLowerCase()}`)
			.orderBy(desc(DB.Tables.minecraftAccounts.updated_at))
			.limit(1)
			.get();
	}

	static async getLinkedAccounts(userID: number, tx: DrizzleDB = DB.instance()) {
		return await tx
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(eq(DB.Tables.minecraftAccounts.user_id, userID))
			.orderBy(DB.Tables.minecraftAccounts.linked_at)
			.all();
	}

	/** Creates or refreshes the account from a Mojang-verified profile. */
	static async upsertVerified(profile: MojangSessionService.Profile, tx: DrizzleDB = DB.instance()) {
		const now = Date.now();

		return await tx
			.insert(DB.Tables.minecraftAccounts)
			.values({
				uuid: profile.uuid,
				name: profile.name,
				skin_url: profile.skin_url,
				skin_model: profile.skin_model,
				last_seen_at: now,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: DB.Tables.minecraftAccounts.uuid,
				set: {
					name: profile.name,
					skin_url: profile.skin_url,
					skin_model: profile.skin_model,
					last_seen_at: now,
					updated_at: now,
				},
			})
			.returning()
			.get();
	}

	/** Marks client activity for the account (throttled). */
	static async touch(account: DB.Models.MinecraftAccount, tx: DrizzleDB = DB.instance()) {
		const now = Date.now();
		if (account.last_seen_at && now - account.last_seen_at < this.LAST_SEEN_UPDATE_INTERVAL_MS) {
			return;
		}
		await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ last_seen_at: now })
			.where(eq(DB.Tables.minecraftAccounts.id, account.id));
	}

	static usesClient(account: DB.Models.MinecraftAccount) {
		return (
			account.last_seen_at !== null && Date.now() - account.last_seen_at < this.USES_CLIENT_WINDOW_MS
		);
	}

	static view(account: DB.Models.MinecraftAccount): SharedViews.MinecraftAccount {
		return {
			uuid: account.uuid,
			name: account.name,
			skin_url: account.skin_url,
			skin_model: account.skin_model,
			uses_client: this.usesClient(account),
			linked_at: account.user_id !== null ? account.linked_at : null,
		};
	}

	static hashLinkCode(code: string) {
		return LCrypt.sha256(code).toHex();
	}

	static getLinkURL(code: string) {
		const appURL = (ConfigHandler.getConfig()?.APP_URL ?? "").replace(/\/+$/, "");
		return `${appURL}${AppConstants.WEBSITE_MINECRAFT_LINK_PATH}?code=${encodeURIComponent(code)}`;
	}

	/** Creates a fresh link code for the account; older codes of the account stop working. */
	static async createLinkCode(accountID: number, tx: DrizzleDB = DB.instance()) {
		const code = LCrypt.randomBytes(24).toString("base64url");
		const expiresAt = Date.now() + this.LINK_CODE_LIFETIME_MS;

		await tx
			.delete(DB.Tables.minecraftLinkCodes)
			.where(eq(DB.Tables.minecraftLinkCodes.minecraft_account_id, accountID));

		await tx.insert(DB.Tables.minecraftLinkCodes).values({
			code_hash: this.hashLinkCode(code),
			minecraft_account_id: accountID,
			expires_at: expiresAt,
		});

		return { code, url: this.getLinkURL(code), expires_at: expiresAt };
	}

	/** The pending link code of an account, if any (for the mod's status poll). */
	static async getPendingLinkCode(accountID: number, tx: DrizzleDB = DB.instance()) {
		const linkCode = await tx
			.select()
			.from(DB.Tables.minecraftLinkCodes)
			.where(eq(DB.Tables.minecraftLinkCodes.minecraft_account_id, accountID))
			.get();
		return linkCode && linkCode.expires_at > Date.now() ? linkCode : null;
	}

	/** Resolves a link code to its account, or null if unknown or expired. */
	static async resolveLinkCode(code: string, tx: DrizzleDB = DB.instance()) {
		const linkCode = await tx
			.select()
			.from(DB.Tables.minecraftLinkCodes)
			.where(eq(DB.Tables.minecraftLinkCodes.code_hash, this.hashLinkCode(code)))
			.get();

		if (!linkCode) {
			return null;
		}

		if (linkCode.expires_at < Date.now()) {
			await tx
				.delete(DB.Tables.minecraftLinkCodes)
				.where(eq(DB.Tables.minecraftLinkCodes.code_hash, linkCode.code_hash));
			return null;
		}

		const account = await this.getByID(linkCode.minecraft_account_id, tx);
		return account ? { linkCode, account } : null;
	}

	/** Consumes a link code and links its Minecraft account to the user. */
	static async link(
		code: string,
		userID: number,
		tx: DrizzleDB = DB.instance(),
	): Promise<MinecraftAccountHandler.LinkResult> {
		const resolved = await this.resolveLinkCode(code, tx);
		if (!resolved) {
			return { ok: false, code: 400, message: "Invalid or expired link code" };
		}

		const { account } = resolved;

		if (account.user_id !== null) {
			return {
				ok: false,
				code: 409,
				message:
					account.user_id === userID
						? "This Minecraft account is already linked to your account"
						: "This Minecraft account is already linked to another account",
			};
		}

		const linkedCount =
			(
				await tx
					.select({ value: count() })
					.from(DB.Tables.minecraftAccounts)
					.where(eq(DB.Tables.minecraftAccounts.user_id, userID))
					.get()
			)?.value ?? 0;

		if (linkedCount >= this.MAX_ACCOUNTS_PER_USER) {
			return {
				ok: false,
				code: 409,
				message: `You can link at most ${this.MAX_ACCOUNTS_PER_USER} Minecraft accounts`,
			};
		}

		// Conditional update: two users confirming the same code concurrently can't both win.
		const linked = await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ user_id: userID, linked_at: Date.now() })
			.where(
				and(
					eq(DB.Tables.minecraftAccounts.id, account.id),
					isNull(DB.Tables.minecraftAccounts.user_id),
				),
			)
			.returning()
			.get();

		if (!linked) {
			return {
				ok: false,
				code: 409,
				message: "This Minecraft account is already linked to another account",
			};
		}

		await tx
			.delete(DB.Tables.minecraftLinkCodes)
			.where(eq(DB.Tables.minecraftLinkCodes.minecraft_account_id, account.id));

		return { ok: true, account: linked };
	}

	/** Unlinks the account from its user and clears its loadout (the items belong to the user). */
	static async unlink(accountID: number, tx: DrizzleDB = DB.instance()) {
		await this.clearLoadout(accountID, tx);
		await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ user_id: null, linked_at: null })
			.where(eq(DB.Tables.minecraftAccounts.id, accountID));
	}

	static async clearLoadout(accountID: number, tx: DrizzleDB = DB.instance()) {
		await tx
			.update(DB.Tables.minecraftAccounts)
			.set({ cape_product_id: null })
			.where(eq(DB.Tables.minecraftAccounts.id, accountID));
		await tx
			.delete(DB.Tables.equippedCosmetics)
			.where(eq(DB.Tables.equippedCosmetics.minecraft_account_id, accountID));
	}

	/** Linked account of the user by UUID, or undefined. */
	static async getLinkedAccount(userID: number, uuid: string, tx: DrizzleDB = DB.instance()) {
		return await tx
			.select()
			.from(DB.Tables.minecraftAccounts)
			.where(
				and(
					eq(DB.Tables.minecraftAccounts.uuid, uuid),
					eq(DB.Tables.minecraftAccounts.user_id, userID),
				),
			)
			.get();
	}
}

export namespace MinecraftAccountHandler {
	export type LinkResult =
		| { ok: true; account: DB.Models.MinecraftAccount }
		| { ok: false; code: 400 | 409; message: string };
}
