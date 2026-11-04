import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import type { DB } from "../../../../../../db";
import { APIResponse } from "../../../../../utils/api-res";
import { AuditLog } from "../../../../../utils/auditLog";
import { AuthHandler } from "../../../../../utils/authHandler";
import { GitLabAPI } from "../../../../../utils/gitlab";
import { ReleaseHandler } from "../../../../../utils/releases";
import { ReleaseDataPolicies } from "../../../../../utils/shared-models/releaseData";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { AdminReleasesModel } from "./model";

export const router = new Hono().basePath("/releases");

/** The managed view of a release row, with the admin who published it. */
function managedViewOf(release: DB.Models.Release) {
	const managed = ReleaseHandler.getManaged(release.version);
	return ReleaseHandler.managedView(release, managed?.creator ?? null);
}

/** Maps a failed release flow outcome onto the API envelope's error responses. */
function respondFailed(c: Context, outcome: ReleaseHandler.Outcome) {
	if (outcome.ok) {
		// callers respond with the row themselves; this only ever maps failures
		return APIResponse.serverError(c, "Unexpected success");
	}

	switch (outcome.status) {
		case 400:
			return APIResponse.badRequest(c, outcome.message);
		case 404:
			return APIResponse.notFound(c, outcome.message);
		case 409:
			return APIResponse.conflict(c, outcome.message);
		case 503:
			return APIResponse.serviceUnavailable(c, outcome.message);
		default:
			return APIResponse.serverError(c, outcome.message);
	}
}

router.get(
	"/",

	APIRouteSpec.authenticated({
		summary: "List releases",
		description:
			"All releases of the mod, in any status: pending builds, failures and retries included.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Releases retrieved successfully", AdminReleasesModel.GetAll.Response),
		),
	}),

	zValidator("query", AdminReleasesModel.GetAll.Query),

	async (c) => {
		const { order, limit, offset } = c.req.valid("query");

		const rows = ReleaseHandler.listManaged(order, limit, offset);
		return APIResponse.success(
			c,
			"Releases retrieved successfully",
			rows.map((row) => ReleaseHandler.managedView(row.release, row.creator)),
		);
	},
);

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Publish a release",
		description: [
			"Two ways to publish: `gitlab_new` (default) creates a new GitLab release — which pushes the",
			"`v<version>` tag and starts the build pipeline — and waits, in the background, until the",
			"pipeline attaches the jar asset; `gitlab_existing` imports a release that already exists on",
			"GitLab (e.g. made by hand), adopting its notes as the changelog. With `auto_modrinth` the",
			"finished release is also published to Modrinth.",
		].join(" "),
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.accepted("Release published", AdminReleasesModel.Create.Response),
			APIResponseSpec.conflict("This version already has a release"),
			APIResponseSpec.serviceUnavailable(
				"The GitLab or Modrinth integration is not configured on the server",
			),
		),
	}),

	zValidator("json", AdminReleasesModel.Create.Body),

	async (c) => {
		const body = c.req.valid("json") as AdminReleasesModel.Create.Body;
		const actor = AuthHandler.AuthContext.getAsUser(c);

		const outcome =
			body.mode === "gitlab_new"
				? await ReleaseHandler.createNew(body, actor.user_id)
				: await ReleaseHandler.importExisting(body, actor.user_id);

		if (outcome.ok) {
			await AuditLog.record({
				actor_user_id: actor.user_id,
				action: "release.create",
				target_type: "release",
				target_id: outcome.release.version,
				details: { mode: body.mode, auto_modrinth: body.auto_modrinth },
			});
			return APIResponse.accepted(c, "Release published", managedViewOf(outcome.release));
		}

		return respondFailed(c, outcome);
	},
);

router.get(
	"/import-candidates",

	APIRouteSpec.authenticated({
		summary: "List GitLab releases to import",
		description:
			"The newest GitLab releases of the mod, with the ones that already have a release on the website marked — the picker of the `gitlab_existing` publish mode.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Import candidates retrieved successfully",
				AdminReleasesModel.ImportCandidates.Response,
			),
			APIResponseSpec.serviceUnavailable("The GitLab integration is not configured on the server"),
		),
	}),

	async (c) => {
		if (!GitLabAPI.isConfigured()) {
			return APIResponse.serviceUnavailable(
				c,
				"The GitLab integration is not configured on the server",
			);
		}

		const releases = await GitLabAPI.listReleases();
		if (!releases.ok) {
			return APIResponse.serverError(c, `Could not read the GitLab releases: ${releases.message}`);
		}

		const candidates = releases.data
			.map((release) => ({ release, version: ReleaseDataPolicies.versionOfTag(release.tag_name) }))
			.filter((entry): entry is { release: GitLabAPI.Release; version: string } =>
				Boolean(entry.version),
			)
			.map(({ release, version }) => ({
				tag: release.tag_name,
				version,
				name: release.name,
				description: release.description ?? "",
				released_at: release.released_at,
				has_jar: GitLabAPI.jarAssetLinkOf(release) !== null,
				imported: Boolean(ReleaseHandler.get(version)),
			}));

		return APIResponse.success(c, "Import candidates retrieved successfully", candidates);
	},
);

router.get(
	"/:version",

	APIRouteSpec.authenticated({
		summary: "Get release",
		description: "One release in any status, including why it failed and where its pipeline is.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Release retrieved successfully", AdminReleasesModel.Version.Response),
			APIResponseSpec.notFound("Release not found"),
		),
	}),

	zValidator("param", AdminReleasesModel.Version.Params),

	async (c) => {
		const { version } = c.req.valid("param");

		const managed = ReleaseHandler.getManaged(version);
		if (!managed) {
			return APIResponse.notFound(c, "Release not found");
		}

		return APIResponse.success(
			c,
			"Release retrieved successfully",
			ReleaseHandler.managedView(managed.release, managed.creator),
		);
	},
);

router.put(
	"/:version",

	APIRouteSpec.authenticated({
		summary: "Edit release",
		description:
			"Change the title and the changelog (markdown). The GitLab release notes follow the changelog, best effort — the website's record is the source of truth.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Release updated successfully", AdminReleasesModel.Update.Response),
			APIResponseSpec.notFound("Release not found"),
		),
	}),

	zValidator("param", AdminReleasesModel.Version.Params),
	zValidator("json", AdminReleasesModel.Update.Body),

	async (c) => {
		const { version } = c.req.valid("param");
		const body = c.req.valid("json") as AdminReleasesModel.Update.Body;
		const actor = AuthHandler.AuthContext.getAsUser(c);

		const outcome = await ReleaseHandler.update(version, body);
		if (outcome.ok) {
			await AuditLog.record({
				actor_user_id: actor.user_id,
				action: "release.update",
				target_type: "release",
				target_id: version,
				details: {
					title: body.title !== undefined,
					changelog: body.changelog !== undefined,
				},
			});
			return APIResponse.success(c, "Release updated successfully", managedViewOf(outcome.release));
		}

		return respondFailed(c, outcome);
	},
);

router.delete(
	"/:version",

	APIRouteSpec.authenticated({
		summary: "Delete release",
		description:
			"Remove the release from the website — it disappears from the public downloads immediately. The GitLab release, its tag and the jar stay untouched.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.successNoData("Release deleted successfully"),
			APIResponseSpec.notFound("Release not found"),
		),
	}),

	zValidator("param", AdminReleasesModel.Version.Params),

	async (c) => {
		const { version } = c.req.valid("param");
		const actor = AuthHandler.AuthContext.getAsUser(c);

		const outcome = await ReleaseHandler.remove(version);
		if (outcome.ok) {
			await AuditLog.record({
				actor_user_id: actor.user_id,
				action: "release.delete",
				target_type: "release",
				target_id: version,
				details: {},
			});
			return APIResponse.successNoData(c, "Release deleted successfully");
		}

		return respondFailed(c, outcome);
	},
);

router.post(
	"/:version/retry",

	APIRouteSpec.authenticated({
		summary: "Retry release",
		description:
			"Put a failed build or a failed Modrinth publish back into its queue: a failed build is re-checked against GitLab (e.g. after its pipeline was retried there), a failed Modrinth publish is attempted again.",
		tags: [DOCS_TAGS.ADMIN_API.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.accepted("Release retry started", AdminReleasesModel.Version.Response),
			APIResponseSpec.notFound("Release not found"),
		),
	}),

	zValidator("param", AdminReleasesModel.Version.Params),

	async (c) => {
		const { version } = c.req.valid("param");
		const actor = AuthHandler.AuthContext.getAsUser(c);

		const outcome = await ReleaseHandler.retry(version);
		if (outcome.ok) {
			await AuditLog.record({
				actor_user_id: actor.user_id,
				action: "release.retry",
				target_type: "release",
				target_id: version,
				details: {},
			});
			return APIResponse.accepted(c, "Release retry started", managedViewOf(outcome.release));
		}

		return respondFailed(c, outcome);
	},
);
