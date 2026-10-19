import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator as zValidator } from "hono-openapi";
import { DB } from "../../../../../../db";
import { APIResponse } from "../../../../../utils/api-res";
import { AssetStore, AssetValidator } from "../../../../../utils/assets";
import { AuthHandler } from "../../../../../utils/authHandler";
import { RateLimiter } from "../../../../../utils/rateLimiter";
import { APIResponseSpec, APIRouteSpec } from "../../../../../utils/specHelpers";
import { DOCS_TAGS } from "../../../docs";
import { StudioAssetsModel } from "./model";

const MAX_UPLOAD_REQUEST_BYTES = AssetValidator.MAX_IMAGE_BYTES + 64 * 1024;

const uploadLimiter = new RateLimiter(100, 24 * 60 * 60 * 1000);

export const router = new Hono().basePath("/assets");

router.post(
	"/",

	APIRouteSpec.authenticated({
		summary: "Upload an asset",
		description:
			"Upload a texture, model or image (multipart/form-data with `file` and `kind`). Files are content-addressed: the returned `id` is the SHA-256 of the stored file, identical uploads share one asset, and the URL never changes. Reference the id from products, variants, collections and pages. Assets nothing references are deleted after 24 hours. Only members of a page (e.g. of their own community page) can upload; limited to 100 uploads per user per day.",
		tags: [DOCS_TAGS.STUDIO.ASSETS],

		responses: APIResponseSpec.describeBasic(
			APIResponseSpec.created("Asset uploaded successfully", StudioAssetsModel.Upload.Response),
			APIResponseSpec.badRequest(
				"The file does not match its kind / Syntax or validation error in request",
			),
			APIResponseSpec.forbidden("Create a community page before uploading files"),
			APIResponseSpec.tooManyRequests("Upload limit reached. Try again later."),
		),
	}),

	bodyLimit({
		maxSize: MAX_UPLOAD_REQUEST_BYTES,
		onError: (c) => APIResponse.badRequest(c, "The file is too large"),
	}),

	zValidator("form", StudioAssetsModel.Upload.Body, undefined, { media: "multipart/form-data" }),

	async (c) => {
		const authContext = AuthHandler.AuthContext.getAsUser(c);

		// Uploads are page content: accounts without a page get no public file hosting.
		if (authContext.user_role !== "admin") {
			const membership = await DB.instance()
				.select({ page_id: DB.Tables.pageMembers.page_id })
				.from(DB.Tables.pageMembers)
				.where(eq(DB.Tables.pageMembers.user_id, authContext.user_id))
				.get();
			if (!membership) {
				return APIResponse.forbidden(c, "Create a community page before uploading files");
			}
		}

		const limit = uploadLimiter.hit(String(authContext.user_id));
		if (!limit.allowed) {
			c.header("Retry-After", limit.retryAfterSeconds.toString());
			return APIResponse.tooManyRequests(c, "Upload limit reached. Try again later.");
		}

		const { file, kind } = c.req.valid("form");

		const validation = AssetValidator.validate(kind, new Uint8Array(await file.arrayBuffer()));
		if (!validation.ok) {
			return APIResponse.badRequest(c, validation.error);
		}

		const asset = await AssetStore.store(validation.asset, authContext.user_id);

		return APIResponse.created(c, "Asset uploaded successfully", {
			asset: {
				id: asset.id,
				url: AssetStore.getURL(asset.id, AssetStore.getExtension(asset.mime_type)),
				mime_type: asset.mime_type,
				size: asset.size,
				width: asset.width,
				height: asset.height,
			},
			warnings: validation.asset.warnings,
		} satisfies StudioAssetsModel.Upload.Response);
	},
);
