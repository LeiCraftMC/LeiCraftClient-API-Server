import { and, asc, desc, eq, or } from "drizzle-orm";
import { DB } from "../../db";
import { ConfigHandler } from "../../utils/config";
import { Logger } from "../../utils/logger";
import { CatalogViews } from "./catalogViews";
import { GitLabAPI } from "./gitlab";
import { ModrinthAPI } from "./modrinth";
import {
	ReleaseDataPolicies,
	ReleaseSettings,
	type ReleaseViews,
} from "./shared-models/releaseData";

/**
 * Releases of the mod: created by admins through the dashboard (a new GitLab release, which the
 * tag pipeline builds, or an import of an existing one), resolved in the background once the
 * pipeline attaches the jar asset, optionally auto-published to Modrinth, and served to the
 * website and the mod's update check once finished.
 */
export class ReleaseHandler {
	/** A build is marked failed when it did not attach its jar within this window (ms). */
	static readonly BUILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

	/** The sync currently running; calls that arrive mid-run chain one more after it. */
	private static currentSync: Promise<void> | null = null;

	// ── Queries ─────────────────────────────────────────────────────────────────────────────

	/** The release of a version, in any status (admin); undefined when it does not exist. */
	static get(version: string): DB.Models.Release | undefined {
		return DB.instance()
			.select()
			.from(DB.Tables.releases)
			.where(eq(DB.Tables.releases.version, version))
			.get();
	}

	/** A release with the admin who published it, for the managed view. */
	static getManaged(
		version: string,
	): { release: DB.Models.Release; creator: DB.Models.User | null } | undefined {
		return DB.instance()
			.select({ release: DB.Tables.releases, creator: DB.Tables.users })
			.from(DB.Tables.releases)
			.leftJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.releases.created_by_user_id))
			.where(eq(DB.Tables.releases.version, version))
			.get();
	}

	/** A finished release (public); undefined while it is pending, failed or missing. */
	static getPublished(version: string): DB.Models.Release | undefined {
		return DB.instance()
			.select()
			.from(DB.Tables.releases)
			.where(and(eq(DB.Tables.releases.version, version), eq(DB.Tables.releases.status, "published")))
			.get();
	}

	/** Finished releases with the admin who published them, newest (default) or oldest first. */
	static listPublished(
		order: "newest" | "oldest",
		limit: number,
		offset: number,
	): Array<{ release: DB.Models.Release; creator: DB.Models.User | null }> {
		return DB.instance()
			.select({ release: DB.Tables.releases, creator: DB.Tables.users })
			.from(DB.Tables.releases)
			.leftJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.releases.created_by_user_id))
			.where(eq(DB.Tables.releases.status, "published"))
			.orderBy(
				order === "newest"
					? desc(DB.Tables.releases.published_at)
					: asc(DB.Tables.releases.published_at),
			)
			.limit(limit)
			.offset(offset)
			.all();
	}

	/** All releases with the admin who published them, newest (default) or oldest first. */
	static listManaged(
		order: "newest" | "oldest",
		limit: number,
		offset: number,
	): Array<{ release: DB.Models.Release; creator: DB.Models.User | null }> {
		return DB.instance()
			.select({ release: DB.Tables.releases, creator: DB.Tables.users })
			.from(DB.Tables.releases)
			.leftJoin(DB.Tables.users, eq(DB.Tables.users.id, DB.Tables.releases.created_by_user_id))
			.orderBy(
				order === "newest" ? desc(DB.Tables.releases.created_at) : asc(DB.Tables.releases.created_at),
			)
			.limit(limit)
			.offset(offset)
			.all();
	}

	// ── Views ───────────────────────────────────────────────────────────────────────────────

	/** Where this release lives on the website (`page_url` in the public view). */
	static pageURL(version: string) {
		const appURL = ConfigHandler.getConfig()?.APP_URL.replace(/\/+$/, "") ?? "";
		return `${appURL}/download#v${version}`;
	}

	/** The shape the website and the mod's update check consume — call with a published release. */
	static publicView(release: DB.Models.Release): ReleaseViews.PublicRelease {
		return {
			version: release.version,
			title: release.title,
			changelog: release.changelog,
			channel: ReleaseSettings.channelOf(release.version),
			published_at: release.published_at as number,
			download_url: release.download_url as string,
			modrinth_url: release.modrinth_url,
			page_url: this.pageURL(release.version),
		};
	}

	/** The shape the admin dashboard consumes, in any status. */
	static managedView(
		release: DB.Models.Release,
		creator: DB.Models.User | null,
	): ReleaseViews.ManagedRelease {
		return {
			version: release.version,
			title: release.title,
			changelog: release.changelog,
			channel: ReleaseSettings.channelOf(release.version),
			status: release.status,
			download_url: release.download_url,
			pipeline_url: release.pipeline_url,
			error_message: release.error_message,
			modrinth_state: release.modrinth_state,
			modrinth_url: release.modrinth_url,
			modrinth_error: release.modrinth_error,
			published_at: release.published_at,
			created_at: release.created_at,
			created_by: creator ? CatalogViews.publicUser(creator) : null,
		};
	}

	// ── Publishing ───────────────────────────────────────────────────────────────────────────

	/**
	 * Publishes a new release: creates the GitLab release — which pushes the tag that starts the
	 * build pipeline — and waits, in the background, until the pipeline attaches the jar asset
	 * (`syncPending`).
	 */
	static async createNew(
		input: { version: string; title?: string; changelog: string; auto_modrinth: boolean },
		actorUserID: number | null,
	): Promise<ReleaseHandler.Outcome> {
		const version = input.version;
		if (this.get(version)) {
			return { ok: false, status: 409, message: `Version ${version} already has a release` };
		}
		if (!GitLabAPI.isConfigured()) {
			return {
				ok: false,
				status: 503,
				message: "The GitLab integration is not configured on the server",
			};
		}
		if (input.auto_modrinth && !ModrinthAPI.isConfigured()) {
			return {
				ok: false,
				status: 503,
				message: "The Modrinth integration is not configured on the server",
			};
		}

		const tag = ReleaseDataPolicies.tagOf(version);
		const title = input.title?.trim() || `LeiCraftClient v${version}`;
		const created = await GitLabAPI.createRelease({
			tag,
			name: title,
			description: input.changelog,
		});
		if (!created.ok) {
			if (created.status === 409) {
				return {
					ok: false,
					status: 409,
					message: `GitLab already has a release ${tag} — import it instead`,
				};
			}
			return { ok: false, status: 500, message: `GitLab rejected the release: ${created.message}` };
		}

		const release = await this.insert({
			version,
			title,
			changelog: input.changelog,
			auto_modrinth: input.auto_modrinth,
			actorUserID,
		});
		if (!release) {
			return { ok: false, status: 409, message: `Version ${version} already has a release` };
		}
		this.kick();
		return { ok: true, release };
	}

	/**
	 * Imports an existing GitLab release; finished right away when its jar asset is already
	 * attached, pending otherwise (same background sync as `createNew`).
	 */
	static async importExisting(
		input: { tag: string; title?: string; changelog?: string; auto_modrinth: boolean },
		actorUserID: number | null,
	): Promise<ReleaseHandler.Outcome> {
		const version = ReleaseDataPolicies.versionOfTag(input.tag);
		if (!version) {
			return { ok: false, status: 400, message: "Not a release tag (like v2.0.0 or v2.0.0-pre.5)" };
		}
		if (this.get(version)) {
			return { ok: false, status: 409, message: `Version ${version} already has a release` };
		}
		if (!GitLabAPI.isConfigured()) {
			return {
				ok: false,
				status: 503,
				message: "The GitLab integration is not configured on the server",
			};
		}
		if (input.auto_modrinth && !ModrinthAPI.isConfigured()) {
			return {
				ok: false,
				status: 503,
				message: "The Modrinth integration is not configured on the server",
			};
		}

		const gitlab = await GitLabAPI.getRelease(input.tag);
		if (!gitlab.ok) {
			if (gitlab.status === 404) {
				return { ok: false, status: 404, message: `GitLab has no release ${input.tag}` };
			}
			return {
				ok: false,
				status: 500,
				message: `Could not read the GitLab release: ${gitlab.message}`,
			};
		}

		const jarLink = GitLabAPI.jarAssetLinkOf(gitlab.data);
		const release = await this.insert({
			version,
			title: input.title?.trim() || gitlab.data.name || `LeiCraftClient v${version}`,
			// the GitLab release notes are a good default the admin can still edit
			changelog: input.changelog?.trim() || gitlab.data.description || "",
			auto_modrinth: input.auto_modrinth,
			actorUserID,
			downloadURL: jarLink?.url ?? null,
		});
		if (!release) {
			return { ok: false, status: 409, message: `Version ${version} already has a release` };
		}
		this.kick();
		return { ok: true, release };
	}

	/** Inserts a release row; null when the version exists already (unique constraint). */
	private static async insert(input: {
		version: string;
		title: string;
		changelog: string;
		auto_modrinth: boolean;
		actorUserID: number | null;
		downloadURL?: string | null;
	}): Promise<DB.Models.Release | null> {
		const published = input.downloadURL != null;
		try {
			return await DB.instance()
				.insert(DB.Tables.releases)
				.values({
					version: input.version,
					title: input.title,
					changelog: input.changelog,
					status: published ? "published" : "pending",
					download_url: input.downloadURL ?? null,
					published_at: published ? Date.now() : null,
					modrinth_state: input.auto_modrinth ? "pending" : "skipped",
					created_by_user_id: input.actorUserID,
				})
				.returning()
				.get();
		} catch (err: any) {
			if (String(err?.message ?? err).includes("UNIQUE constraint failed")) {
				return null;
			}
			throw err;
		}
	}

	// ── Editing & removal ─────────────────────────────────────────────────────────────────────

	/**
	 * Edits title and changelog. The GitLab release notes follow the changelog so both stay the
	 * same, best effort: a release imported before the tag existed — or removed on GitLab — does
	 * not make the edit fail.
	 */
	static async update(
		version: string,
		input: { title?: string; changelog?: string },
	): Promise<ReleaseHandler.Outcome> {
		const release = this.get(version);
		if (!release) {
			return { ok: false, status: 404, message: "Release not found" };
		}

		const title =
			input.title !== undefined ? input.title.trim() || `LeiCraftClient v${version}` : release.title;
		const changelog = input.changelog !== undefined ? input.changelog : release.changelog;

		const updated = await DB.instance()
			.update(DB.Tables.releases)
			.set({ title, changelog })
			.where(eq(DB.Tables.releases.id, release.id))
			.returning()
			.get();

		if (changelog !== release.changelog) {
			await GitLabAPI.updateReleaseNotes(ReleaseDataPolicies.tagOf(version), changelog);
		}
		return { ok: true, release: updated };
	}

	/** Removes a release from the website; the GitLab release and its tag stay untouched. */
	static async remove(version: string): Promise<ReleaseHandler.Outcome> {
		const release = this.get(version);
		if (!release) {
			return { ok: false, status: 404, message: "Release not found" };
		}
		await DB.instance().delete(DB.Tables.releases).where(eq(DB.Tables.releases.id, release.id));
		return { ok: true, release };
	}

	/**
	 * Puts a failed build or a failed Modrinth publish back into its queue: a failed build is
	 * re-checked against GitLab (e.g. after the pipeline was retried there), a failed Modrinth
	 * publish is attempted again.
	 */
	static async retry(version: string): Promise<ReleaseHandler.Outcome> {
		const release = this.get(version);
		if (!release) {
			return { ok: false, status: 404, message: "Release not found" };
		}

		if (release.status === "failed") {
			const updated = await DB.instance()
				.update(DB.Tables.releases)
				.set({ status: "pending", error_message: null })
				.where(and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.status, "failed")))
				.returning()
				.get();
			if (updated) this.kick();
			return { ok: true, release: updated ?? release };
		}

		if (release.status === "published" && release.modrinth_state === "failed") {
			const updated = await DB.instance()
				.update(DB.Tables.releases)
				.set({ modrinth_state: "pending", modrinth_error: null })
				.where(
					and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.modrinth_state, "failed")),
				)
				.returning()
				.get();
			if (updated) this.kick();
			return { ok: true, release: updated ?? release };
		}

		return { ok: false, status: 400, message: "This release has nothing to retry" };
	}

	// ── Background sync ───────────────────────────────────────────────────────────────────────

	/** Starts a sync right away (fire and forget); the cron job also runs every minute. */
	static kick() {
		this.syncPending();
	}

	/**
	 * Resolves everything that is unfinished: pending builds wait for the jar asset link and
	 * fail when the pipeline fails or the build times out; published releases with a pending
	 * Modrinth publish get it. Each call runs its own pass — chained after any running one, so
	 * it also sees rows inserted meanwhile — and every transition is a conditional UPDATE, so
	 * concurrent passes can't double-apply.
	 */
	static syncPending(): Promise<void> {
		const previous = this.currentSync;
		const run = (previous ?? Promise.resolve())
			.then(() => this.runSync())
			.catch((err: any) => {
				Logger.error("Release sync failed:", err?.message ?? err);
			})
			.finally(() => {
				if (this.currentSync === run) this.currentSync = null;
			});
		this.currentSync = run;
		return run;
	}

	private static async runSync() {
		const rows = await DB.instance()
			.select()
			.from(DB.Tables.releases)
			.where(
				or(
					eq(DB.Tables.releases.status, "pending"),
					and(
						eq(DB.Tables.releases.status, "published"),
						eq(DB.Tables.releases.modrinth_state, "pending"),
					),
				),
			)
			.all();

		for (const release of rows) {
			try {
				const current = release.status === "pending" ? await this.syncBuild(release) : release;
				if (current.status === "published" && current.modrinth_state === "pending") {
					await this.publishToModrinth(current);
				}
			} catch (err: any) {
				Logger.error(`Release sync of ${release.version} failed:`, err?.message ?? err);
			}
		}
	}

	/**
	 * One check of a pending build: published when the jar asset link is attached, failed when
	 * the pipeline failed (or was canceled or skipped) or the build timed out; still pending
	 * while the pipeline runs.
	 */
	private static async syncBuild(release: DB.Models.Release): Promise<DB.Models.Release> {
		const tag = ReleaseDataPolicies.tagOf(release.version);

		const gitlab = await GitLabAPI.getRelease(tag);
		if (!gitlab.ok) {
			if (gitlab.status === 404) {
				// gone on GitLab, e.g. removed by hand after a wrong publish
				return this.markFailed(release, `The GitLab release ${tag} no longer exists`);
			}
			// unreachable or not configured: nothing to decide here, try again next sync
			Logger.debug(`Release sync of ${release.version} could not read GitLab: ${gitlab.message}`);
			return release;
		}

		const jarLink = GitLabAPI.jarAssetLinkOf(gitlab.data);
		if (jarLink) {
			const published = await DB.instance()
				.update(DB.Tables.releases)
				.set({
					status: "published",
					download_url: jarLink.url,
					published_at: Date.now(),
					error_message: null,
				})
				.where(and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.status, "pending")))
				.returning()
				.get();
			if (published) Logger.info(`Release ${release.version} is out — the jar asset is attached.`);
			return published ?? release;
		}

		const pipeline = await GitLabAPI.getPipelineForRef(tag);
		if (pipeline.ok && ["failed", "canceled", "skipped"].includes(pipeline.data.status)) {
			return this.markFailed(
				release,
				`The build pipeline ${pipeline.data.status}`,
				pipeline.data.web_url,
			);
		}

		if (Date.now() - release.created_at > ReleaseHandler.BUILD_TIMEOUT_MS) {
			return this.markFailed(
				release,
				"Timed out waiting for the build to attach the jar",
				pipeline.ok ? pipeline.data.web_url : null,
			);
		}

		// still building: remember the pipeline so the dashboard can link to its live logs
		if (pipeline.ok && pipeline.data.web_url !== release.pipeline_url) {
			const updated = await DB.instance()
				.update(DB.Tables.releases)
				.set({ pipeline_url: pipeline.data.web_url })
				.where(and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.status, "pending")))
				.returning()
				.get();
			return updated ?? release;
		}
		return release;
	}

	/** Marks a pending build failed; the row is only touched while it is still pending. */
	private static async markFailed(
		release: DB.Models.Release,
		message: string,
		pipelineURL?: string | null,
	): Promise<DB.Models.Release> {
		const failed = await DB.instance()
			.update(DB.Tables.releases)
			.set({
				status: "failed",
				error_message: message,
				pipeline_url: pipelineURL ?? release.pipeline_url,
			})
			.where(and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.status, "pending")))
			.returning()
			.get();
		Logger.warn(`Release ${release.version} failed: ${message}`);
		return failed ?? release;
	}

	/**
	 * Publishes a finished release to Modrinth. The Minecraft versions come from the tag's own
	 * `gradle.properties`, so they always match what was actually built. Transient network errors
	 * leave the publish pending for the next sync; everything else fails visibly for a retry.
	 */
	private static async publishToModrinth(release: DB.Models.Release) {
		const tag = ReleaseDataPolicies.tagOf(release.version);

		const gradle = await GitLabAPI.getFile("gradle.properties", tag);
		if (!gradle.ok && gradle.status === 0) return; // unreachable right now; the next sync retries

		const minecraftVersion = gradle.ok
			? gradle.data.match(/^minecraft_version\s*=\s*(\S+)/m)?.[1]
			: null;
		if (!minecraftVersion) {
			await this.finishModrinth(release, {
				ok: false,
				status: gradle.ok ? 500 : gradle.status,
				message: gradle.ok
					? `No minecraft_version in gradle.properties at ${tag}`
					: `Could not read gradle.properties at ${tag}: ${gradle.message}`,
			});
			return;
		}

		const result = await ModrinthAPI.publishVersion({
			versionNumber: release.version,
			name: release.title,
			changelog: release.changelog,
			gameVersions: [minecraftVersion],
			versionType: ReleaseSettings.channelOf(release.version) === "pre-release" ? "beta" : "release",
			jarURL: release.download_url as string,
		});
		if (!result.ok && result.status === 0) return; // unreachable right now; the next sync retries
		await this.finishModrinth(release, result);
	}

	/** Records a Modrinth publish outcome on the release; only while it is still pending. */
	private static async finishModrinth(
		release: DB.Models.Release,
		result: ModrinthAPI.Result<ModrinthAPI.CreatedVersion>,
	) {
		await DB.instance()
			.update(DB.Tables.releases)
			.set(
				result.ok
					? { modrinth_state: "published", modrinth_url: result.data.url, modrinth_error: null }
					: { modrinth_state: "failed", modrinth_error: result.message },
			)
			.where(
				and(eq(DB.Tables.releases.id, release.id), eq(DB.Tables.releases.modrinth_state, "pending")),
			);
	}
}

export namespace ReleaseHandler {
	/** A release flow result; the routes map `status` onto the matching API envelope. */
	export type Outcome =
		| { ok: true; release: DB.Models.Release }
		| { ok: false; status: 400 | 404 | 409 | 500 | 503; message: string };
}
