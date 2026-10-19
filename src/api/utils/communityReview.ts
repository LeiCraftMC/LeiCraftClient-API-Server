import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { DB } from "../../db";
import type { DrizzleDB } from "../../db/utils";
import type { UserAccountSettings } from "./shared-models/accountData";
import type { CatalogSettings } from "./shared-models/catalogData";

/**
 * Moderator review of community page profiles (name, slug, description, icon, banner) and their
 * collections — the same "public after review" rule as for community products.
 *
 * - A community page and its collections are public only after a moderator approved the profile
 *   once (`reviewed_at`). Until then, edits apply directly.
 * - After that, edits wait in `pending_changes`; the catalog keeps the approved values.
 * - Every change sets `review_requested_at` (the moderation queue); approve / reject clear it.
 * - Admins edit directly, without a review.
 */
export class CommunityReview {
	/** Whether changes by this actor on this page go through the review. */
	static appliesTo(page: DB.Models.Page, actorRole: UserAccountSettings.Role) {
		return page.category === "community" && actorRole !== "admin";
	}

	static async requestReview(pageID: number, tx: DrizzleDB = DB.instance()) {
		const now = Date.now();
		await tx
			.update(DB.Tables.pages)
			.set({ review_requested_at: now, updated_at: now })
			.where(eq(DB.Tables.pages.id, pageID));
	}

	/** Applies page profile changes directly or queues them, depending on the page's review state. */
	static async submitPageChanges(
		page: DB.Models.Page,
		changes: CatalogSettings.PagePendingChanges,
		tx: DrizzleDB = DB.instance(),
	) {
		if (page.reviewed_at === null) {
			await tx
				.update(DB.Tables.pages)
				.set({ ...changes, updated_at: Date.now() })
				.where(eq(DB.Tables.pages.id, page.id));
		} else {
			await tx
				.update(DB.Tables.pages)
				.set({ pending_changes: { ...(page.pending_changes ?? {}), ...changes } })
				.where(eq(DB.Tables.pages.id, page.id));
		}
		await this.requestReview(page.id, tx);
	}

	/** Same as {@link submitPageChanges} for a collection of a community page. */
	static async submitCollectionChanges(
		collection: DB.Models.Collection,
		changes: CatalogSettings.CollectionPendingChanges,
		tx: DrizzleDB = DB.instance(),
	) {
		if (collection.reviewed_at === null) {
			await tx
				.update(DB.Tables.collections)
				.set({ ...changes, updated_at: Date.now() })
				.where(eq(DB.Tables.collections.id, collection.id));
		} else {
			await tx
				.update(DB.Tables.collections)
				.set({
					pending_changes: { ...(collection.pending_changes ?? {}), ...changes },
					updated_at: Date.now(),
				})
				.where(eq(DB.Tables.collections.id, collection.id));
		}
		await this.requestReview(collection.page_id, tx);
	}

	/** Collections of the pages that are new or have pending changes, keyed by page id. */
	static async loadCollectionsToReview(pageIDs: number[], tx: DrizzleDB = DB.instance()) {
		const byPage = new Map<number, DB.Models.Collection[]>();
		if (pageIDs.length === 0) {
			return byPage;
		}

		const rows = await tx
			.select()
			.from(DB.Tables.collections)
			.where(
				and(
					inArray(DB.Tables.collections.page_id, pageIDs),
					or(
						isNull(DB.Tables.collections.reviewed_at),
						isNotNull(DB.Tables.collections.pending_changes),
					),
				),
			)
			.all();

		for (const row of rows) {
			const list = byPage.get(row.page_id) ?? [];
			list.push(row);
			byPage.set(row.page_id, list);
		}
		return byPage;
	}

	/** Publishes the page profile and all collections of the page, with their pending changes. */
	static async approve(
		page: DB.Models.Page,
		tx: DrizzleDB = DB.instance(),
	): Promise<CommunityReview.Result> {
		const changes = page.pending_changes ?? {};

		if (changes.slug && changes.slug !== page.slug) {
			const taken = await tx
				.select({ id: DB.Tables.pages.id })
				.from(DB.Tables.pages)
				.where(
					and(
						eq(DB.Tables.pages.category, page.category),
						eq(DB.Tables.pages.slug, changes.slug),
						ne(DB.Tables.pages.id, page.id),
					),
				)
				.get();
			if (taken) {
				return { ok: false, code: 409, message: "The requested slug is taken by another page" };
			}
		}

		const now = Date.now();
		const updated = await tx
			.update(DB.Tables.pages)
			.set({
				...changes,
				pending_changes: null,
				reviewed_at: now,
				review_requested_at: null,
				review_note: null,
				updated_at: now,
			})
			.where(eq(DB.Tables.pages.id, page.id))
			.returning()
			.get();

		const collections = await tx
			.select()
			.from(DB.Tables.collections)
			.where(eq(DB.Tables.collections.page_id, page.id))
			.all();

		for (const collection of collections) {
			if (collection.reviewed_at !== null && collection.pending_changes === null) continue;
			await tx
				.update(DB.Tables.collections)
				.set({ ...(collection.pending_changes ?? {}), pending_changes: null, reviewed_at: now })
				.where(eq(DB.Tables.collections.id, collection.id));
		}

		return { ok: true, page: updated };
	}

	/** Discards the pending changes of the page and its collections; new items stay unpublished. */
	static async reject(page: DB.Models.Page, reason: string, tx: DrizzleDB = DB.instance()) {
		const updated = await tx
			.update(DB.Tables.pages)
			.set({
				pending_changes: null,
				review_requested_at: null,
				review_note: reason,
				updated_at: Date.now(),
			})
			.where(eq(DB.Tables.pages.id, page.id))
			.returning()
			.get();

		await tx
			.update(DB.Tables.collections)
			.set({ pending_changes: null })
			.where(eq(DB.Tables.collections.page_id, page.id));

		return updated;
	}
}

export namespace CommunityReview {
	export type Result =
		| { ok: true; page: DB.Models.Page }
		| { ok: false; code: 409; message: string };
}
