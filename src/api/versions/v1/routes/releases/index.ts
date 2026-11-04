import { Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { APIResponse } from "../../../../utils/api-res";
import { ReleaseHandler } from "../../../../utils/releases";
import { APIResponseSpec, APIRouteSpec } from "../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../docs";
import { ReleasesModel } from "./model";

export const router = new Hono().basePath("/releases");

router.get(
	"/",

	APIRouteSpec.unauthenticated({
		summary: "List releases",
		description:
			"Finished releases of the LeiCraft Client mod, newest first: changelog (markdown), the direct jar download and the Modrinth page — what the download page and the mod's update check consume.",
		tags: [DOCS_TAGS.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Releases retrieved successfully", ReleasesModel.GetAll.Response),
		),
	}),

	zValidator("query", ReleasesModel.GetAll.Query),

	async (c) => {
		const { order, limit, offset } = c.req.valid("query");

		const rows = ReleaseHandler.listPublished(order, limit, offset);
		return APIResponse.success(
			c,
			"Releases retrieved successfully",
			rows.map((row) => ReleaseHandler.publicView(row.release)),
		);
	},
);

router.get(
	"/latest",

	APIRouteSpec.unauthenticated({
		summary: "Get the latest release",
		description: "The most recently published release, for download pages and update banners.",
		tags: [DOCS_TAGS.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success(
				"Latest release retrieved successfully",
				ReleasesModel.GetLatest.Response,
			),
			APIResponseSpec.notFound("No release published yet"),
		),
	}),

	async (c) => {
		const [latest] = ReleaseHandler.listPublished("newest", 1, 0);
		if (!latest) {
			return APIResponse.notFound(c, "No release published yet");
		}

		return APIResponse.success(
			c,
			"Latest release retrieved successfully",
			ReleaseHandler.publicView(latest.release),
		);
	},
);

router.get(
	"/:version",

	APIRouteSpec.unauthenticated({
		summary: "Get release",
		description: "One finished release by mod version (without the leading v of the GitLab tag).",
		tags: [DOCS_TAGS.RELEASES],

		responses: APIResponseSpec.describeWithWrongInputs(
			APIResponseSpec.success("Release retrieved successfully", ReleasesModel.GetByVersion.Response),
			APIResponseSpec.notFound("Release not found"),
		),
	}),

	zValidator("param", ReleasesModel.GetByVersion.Params),

	async (c) => {
		const { version } = c.req.valid("param");

		const release = ReleaseHandler.getPublished(version);
		if (!release) {
			return APIResponse.notFound(c, "Release not found");
		}

		return APIResponse.success(
			c,
			"Release retrieved successfully",
			ReleaseHandler.publicView(release),
		);
	},
);
