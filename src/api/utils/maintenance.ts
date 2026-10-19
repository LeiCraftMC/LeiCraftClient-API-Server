import { lt } from "drizzle-orm";
import { DB } from "../../db";
import { Logger } from "../../utils/logger";
import { AssetStore } from "./assets";

/** Periodic housekeeping, run by the cron jobs in `src/utils/cron.ts`. */
export class MaintenanceTasks {
	/** Unreferenced uploads are kept this long, so a studio form can upload first and save later. */
	static readonly ORPHAN_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;

	/** Deletes expired login states, handshake challenges, link codes and sessions. */
	static async cleanupExpiredRows() {
		const now = Date.now();

		await DB.instance()
			.delete(DB.Tables.oauthStates)
			.where(lt(DB.Tables.oauthStates.expires_at, now));
		await DB.instance()
			.delete(DB.Tables.clientAuthChallenges)
			.where(lt(DB.Tables.clientAuthChallenges.expires_at, now));
		await DB.instance()
			.delete(DB.Tables.minecraftLinkCodes)
			.where(lt(DB.Tables.minecraftLinkCodes.expires_at, now));
		await DB.instance().delete(DB.Tables.sessions).where(lt(DB.Tables.sessions.expires_at, now));
		await DB.instance()
			.delete(DB.Tables.clientSessions)
			.where(lt(DB.Tables.clientSessions.expires_at, now));
	}

	static async cleanupOrphanAssets() {
		const deleted = await AssetStore.cleanupOrphans(this.ORPHAN_ASSET_GRACE_MS);
		if (deleted > 0) {
			Logger.info(`Deleted ${deleted} unused asset(s)`);
		}
	}
}
