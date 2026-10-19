import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import { AuthHandler } from "./authHandler";
import { MinecraftAccountHandler } from "./minecraftAccounts";
import { UserPreferencesHandler } from "./preferences";

export class UserHandler {
	static async getByID(userID: number, tx: DrizzleDB = DB.instance()) {
		return await tx.select().from(DB.Tables.users).where(eq(DB.Tables.users.id, userID)).get();
	}

	static isBanned(user: Pick<DB.Models.User, "banned_at" | "banned_until">) {
		return user.banned_at !== null && (user.banned_until === null || user.banned_until > Date.now());
	}

	/**
	 * Finds the user a studio action targets: by LeiCraft user id, Discord id, or a linked
	 * Minecraft account (UUID or name). Returns undefined if nobody matches. A name is only
	 * accepted if exactly one LeiCraft user has a linked account with it — names move between
	 * Minecraft accounts, so the stored name of a renamed account can be stale.
	 */
	static async resolveTarget(target: UserHandler.Target, tx: DrizzleDB = DB.instance()) {
		if (target.user_id !== undefined) {
			return await this.getByID(target.user_id, tx);
		}

		if (target.discord_id !== undefined) {
			return await tx
				.select()
				.from(DB.Tables.users)
				.where(eq(DB.Tables.users.discord_id, target.discord_id))
				.get();
		}

		if (target.minecraft_uuid !== undefined) {
			const account = await MinecraftAccountHandler.getByUUID(target.minecraft_uuid, tx);
			if (!account || account.user_id === null) {
				return undefined;
			}
			return await this.getByID(account.user_id, tx);
		}

		if (target.minecraft_name !== undefined) {
			const linked = await tx
				.select({ user_id: DB.Tables.minecraftAccounts.user_id })
				.from(DB.Tables.minecraftAccounts)
				.where(
					and(
						sql`lower(${DB.Tables.minecraftAccounts.name}) = ${target.minecraft_name.toLowerCase()}`,
						isNotNull(DB.Tables.minecraftAccounts.user_id),
					),
				)
				.all();

			const userIDs = [...new Set(linked.map((row) => row.user_id as number))];
			if (userIDs.length > 1) {
				return "ambiguous" as const;
			}
			return userIDs[0] === undefined ? undefined : await this.getByID(userIDs[0], tx);
		}

		return undefined;
	}

	/** Bans the user: revokes all sessions and API keys; their items stop showing in-game. */
	static async ban(
		userID: number,
		reason: string,
		bannedUntil: number | null,
		tx: DrizzleDB = DB.instance(),
	) {
		await tx
			.update(DB.Tables.users)
			.set({ banned_at: Date.now(), banned_until: bannedUntil, ban_reason: reason })
			.where(eq(DB.Tables.users.id, userID));

		await AuthHandler.invalidateAllAuthContextsForUser(userID, tx);
	}

	static async unban(userID: number, tx: DrizzleDB = DB.instance()) {
		await tx
			.update(DB.Tables.users)
			.set({ banned_at: null, banned_until: null, ban_reason: null })
			.where(eq(DB.Tables.users.id, userID));
	}

	/**
	 * Deletes a user and everything that belongs only to them: sessions, API keys, preferences,
	 * inventory, Minecraft links (accounts stay, unlinked) and the community pages they own.
	 * Official and partner content they created stays (creator is set to null).
	 */
	static async deleteUser(userID: number, tx: DrizzleDB = DB.instance()) {
		await AuthHandler.invalidateAllAuthContextsForUser(userID, tx);
		await UserPreferencesHandler.deleteAllForUser(userID, tx);

		for (const account of await MinecraftAccountHandler.getLinkedAccounts(userID, tx)) {
			await MinecraftAccountHandler.unlink(account.id, tx);
		}

		const ownedCommunityPages = await tx
			.select({ id: DB.Tables.pages.id })
			.from(DB.Tables.pages)
			.innerJoin(DB.Tables.pageMembers, eq(DB.Tables.pageMembers.page_id, DB.Tables.pages.id))
			.where(
				and(
					eq(DB.Tables.pages.category, "community"),
					eq(DB.Tables.pageMembers.user_id, userID),
					eq(DB.Tables.pageMembers.role, "owner"),
				),
			)
			.all();

		if (ownedCommunityPages.length > 0) {
			await tx.delete(DB.Tables.pages).where(
				inArray(
					DB.Tables.pages.id,
					ownedCommunityPages.map((page) => page.id),
				),
			);
		}

		await tx.delete(DB.Tables.users).where(eq(DB.Tables.users.id, userID));
	}
}

export namespace UserHandler {
	/** Exactly one field is set. */
	export interface Target {
		user_id?: number;
		discord_id?: string;
		minecraft_uuid?: string;
		minecraft_name?: string;
	}
}
