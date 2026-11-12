import z from "zod";
import { SharedViews } from "./views";

/**
 * Releases of the LeiCraftClient Fabric mod. A release is created on the admin dashboard and
 * either triggers a new GitLab release (tag + pipeline + jar asset) or imports an existing one;
 * the public endpoints only serve releases that finished (`status === "published"`).
 */
export namespace ReleaseSettings {
	export const Statuses = ["pending", "published", "failed"] as const;
	export const Status = z.enum(Statuses);
	export type Status = z.infer<typeof Status>;

	/** Independent of the build: a published release may still have a failed Modrinth publish. */
	export const ModrinthStates = ["skipped", "pending", "published", "failed"] as const;
	export const ModrinthState = z.enum(ModrinthStates);
	export type ModrinthState = z.infer<typeof ModrinthState>;

	/**
	 * Derived from the version: everything after a `-` is a pre-release suffix
	 * (`2.0.0-pre.5` → `pre-release`), matching how the mod's update check treats versions.
	 */
	export const Channels = ["stable", "pre-release"] as const;
	export const Channel = z.enum(Channels);
	export type Channel = z.infer<typeof Channel>;

	export function channelOf(version: string): Channel {
		return version.includes("-") ? "pre-release" : "stable";
	}
}

export namespace ReleaseDataPolicies {
	/**
	 * Mod version without the leading `v` of the GitLab tag, matching the CI's tag rule
	 * (`v\d+\.\d+\.\d+…`) — e.g. `2.0.0` or `2.0.0-pre.5`.
	 */
	export const Version = z
		.string()
		.regex(
			/^\d+\.\d+\.\d+(-[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/,
			"Must be a version like 2.0.0 or 2.0.0-pre.5",
		)
		.describe("Mod version without the leading v");

	export type Version = z.infer<typeof Version>;

	/** The GitLab tag of a version: the version with a leading `v`. */
	export function tagOf(version: string): string {
		return `v${version}`;
	}

	/** The version part of a GitLab tag, or null if the tag is not a `v…` release tag. */
	export function versionOfTag(tag: string): string | null {
		if (!tag.startsWith("v")) return null;
		const version = tag.slice(1);
		return Version.safeParse(version).success ? version : null;
	}
}

export namespace ReleaseViews {
	/** A finished release as the website and the mod's update check see it. */
	export const PublicRelease = z.object({
		version: z.string().describe("Mod version without the leading v, e.g. 2.0.0-pre.5"),
		title: z.string().describe("Display name of the release"),
		changelog: z.string().describe("Changelog, markdown"),
		channel: ReleaseSettings.Channel,
		published_at: z.number().int().describe("Unix ms when the jar became downloadable"),
		download_url: z
			.string()
			.describe(
				"Direct download of the mod jar (GitLab package registry permalink of the release asset)",
			),
		modrinth_url: z
			.string()
			.nullable()
			.describe("Modrinth version page, when it was published there"),
		page_url: z.string().describe("Website page of this release"),
	});
	export type PublicRelease = z.infer<typeof PublicRelease>;

	/** A release as admins see it, in any status. */
	export const ManagedRelease = z.object({
		version: z.string(),
		title: z.string(),
		changelog: z.string().describe("Changelog, markdown"),
		channel: ReleaseSettings.Channel,
		status: ReleaseSettings.Status,
		download_url: z.string().nullable(),
		pipeline_url: z
			.string()
			.nullable()
			.describe("GitLab pipeline of the tag build (why it failed, build logs)"),
		error_message: z.string().nullable(),
		modrinth_state: ReleaseSettings.ModrinthState,
		modrinth_url: z.string().nullable(),
		modrinth_error: z.string().nullable(),
		published_at: z.number().int().nullable(),
		created_at: z.number().int(),
		created_by: SharedViews.PublicUser.nullable(),
	});
	export type ManagedRelease = z.infer<typeof ManagedRelease>;
}
