import { z } from "zod";
import { ReleaseDataPolicies, ReleaseViews } from "../../../../../utils/shared-models/releaseData";

export namespace AdminReleasesModel.GetAll {
	export const Query = z.object({
		order: z.enum(["newest", "oldest"]).default("newest"),
		limit: z.coerce.number().int().min(1).max(200).default(50),
		offset: z.coerce.number().int().min(0).default(0),
	});
	export type Query = z.infer<typeof Query>;

	export const Response = z.array(ReleaseViews.ManagedRelease);
	export type Response = z.infer<typeof Response>;
}

export namespace AdminReleasesModel.Create {
	/**
	 * The two ways to publish: trigger a new GitLab release (default) or import an existing one.
	 * The tag pattern is the one the build pipeline runs on (`v…`).
	 */
	export const Body = z.discriminatedUnion("mode", [
		z.object({
			mode: z.literal("gitlab_new"),
			version: ReleaseDataPolicies.Version,
			title: z.string().trim().max(120).optional(),
			changelog: z.string().trim().min(1).max(10000),
			auto_modrinth: z.boolean().default(true),
		}),
		z.object({
			mode: z.literal("gitlab_existing"),
			tag: z
				.string()
				.trim()
				.regex(/^v\d+\.\d+\.\d+(-[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/, "Must be a release tag like v2.0.0"),
			title: z.string().trim().max(120).optional(),
			changelog: z.string().trim().max(10000).optional(),
			auto_modrinth: z.boolean().default(true),
		}),
	]);
	export type Body = z.infer<typeof Body>;

	export const Response = ReleaseViews.ManagedRelease;
	export type Response = z.infer<typeof Response>;
}

export namespace AdminReleasesModel.Version {
	export const Params = z.object({
		version: ReleaseDataPolicies.Version,
	});
	export type Params = z.infer<typeof Params>;

	export const Response = ReleaseViews.ManagedRelease;
	export type Response = z.infer<typeof Response>;
}

export namespace AdminReleasesModel.Update {
	export const Body = z
		.object({
			title: z.string().trim().max(120).optional(),
			changelog: z.string().trim().max(10000).optional(),
		})
		.refine((body) => body.title !== undefined || body.changelog !== undefined, {
			message: "Nothing to update",
		});
	export type Body = z.infer<typeof Body>;

	export const Response = ReleaseViews.ManagedRelease;
	export type Response = z.infer<typeof Response>;
}

export namespace AdminReleasesModel.ImportCandidates {
	/** A GitLab release that exists already, e.g. one made by hand in the GitLab UI. */
	export const Candidate = z.object({
		tag: z.string(),
		version: z.string(),
		name: z.string(),
		description: z.string().describe("Release notes on GitLab (markdown) — the changelog default"),
		released_at: z.string(),
		has_jar: z.boolean().describe("The build already attached the jar asset"),
		imported: z.boolean().describe("Already has a release on the website"),
	});
	export type Candidate = z.infer<typeof Candidate>;

	export const Response = z.array(Candidate);
	export type Response = z.infer<typeof Response>;
}
