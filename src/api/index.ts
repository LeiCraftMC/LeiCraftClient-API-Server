import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { prettyJSON } from "hono/pretty-json";
import { openAPIRouteHandler } from "hono-openapi";
import { AppConstants } from "../utils/constants";
import { Logger } from "../utils/logger";
import { APIResponse } from "./utils/api-res";
import type { APIVersionRouter } from "./utils/apiVersionRouter";
import { AssetStore } from "./utils/assets";
import { APIv1Router } from "./versions/v1";

export class API {
	protected static server: Bun.Server<undefined> | null = null;
	protected static app: Hono | null;

	protected static latestVersion: number | null = null;

	protected static registerVersion(versionRouter: APIVersionRouter, disableDocs: boolean) {
		if (!this.app) {
			throw new Error("API not initialized. Call API.init() first.");
		}

		this.app.route(`/v${versionRouter.version}`, versionRouter.router);

		if (!this.latestVersion || versionRouter.version > this.latestVersion) {
			this.latestVersion = versionRouter.version;
		}

		if (!disableDocs) {
			this.app.get(
				`/docs/v${versionRouter.version}/openapi`,
				openAPIRouteHandler(versionRouter.router, versionRouter.openAPIConfig),
			);

			this.app.get(
				`/docs/v${versionRouter.version}`,
				// Relative, so the docs page also finds its spec when the API is mounted under a prefix.
				Scalar({ url: `./v${versionRouter.version}/openapi` }),
			);
		}
	}

	/**
	 * Build the Hono app: prettyJSON, CORS (allow the frontend origins), error handler,
	 * versioned routes, docs, /health, and a `/` redirect to the latest docs. Does NOT
	 * call Bun.serve — call `start(port, hostname)` for that.
	 */
	static async init(frontendUrls: string[], disableDocs: boolean) {
		this.app = new Hono();

		this.app.use(prettyJSON());

		const frontendCors = cors({
			origin: frontendUrls,
			allowHeaders: ["Content-Type", "Authorization"],
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			maxAge: 600,
			credentials: true,
		});
		// Assets are public files any site may embed (e.g. the SkinViewerJS product viewer).
		const assetsCors = cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 });

		this.app.use("*", async (c, next) => {
			return c.req.path.startsWith("/assets/") ? assetsCors(c, next) : frontendCors(c, next);
		});

		this.app.onError((err, c) => {
			if (err instanceof HTTPException) {
				// Return only safe error metadata — never leak Zod validation details
				return c.json(
					{
						success: false,
						code: err.status,
						message: "Your input is invalid",
					},
					err.status,
				);
			}

			Logger.error("Unhandled API error:", err);
			return c.json({ success: false, code: 500, message: "Internal Server Error" }, 500);
		});

		this.registerVersion(new APIv1Router(), disableDocs);

		this.app.get("/health", (c) => {
			return c.json({
				success: true,
				code: 200,
				message: `${AppConstants.APP_NAME} API is running`,
				data: null,
			});
		});

		// Uploaded files, content-addressed (`<sha256>.<png|json>`). Raw file responses, not the
		// JSON envelope — they are textures and models for the mod and SkinViewerJS.
		this.app.get("/assets/:file", async (c) => {
			const match = /^([0-9a-f]{64})\.(png|json)$/.exec(c.req.param("file"));
			if (!match) {
				return APIResponse.notFound(c, "Asset not found");
			}
			const [, assetID, extension] = match as unknown as [string, string, "png" | "json"];

			const asset = await AssetStore.get(assetID);
			if (!asset || AssetStore.getExtension(asset.mime_type) !== extension) {
				return APIResponse.notFound(c, "Asset not found");
			}

			const headers = {
				"Cache-Control": "public, max-age=31536000, immutable",
				ETag: `"${asset.id}"`,
				"X-Content-Type-Options": "nosniff",
			};

			if (c.req.header("If-None-Match") === `"${asset.id}"`) {
				return c.body(null, 304, headers);
			}

			const file = Bun.file(AssetStore.getFilePath(asset.id));
			if (!(await file.exists())) {
				Logger.error(`Asset file missing on disk: ${asset.id}`);
				return APIResponse.notFound(c, "Asset not found");
			}

			return c.body(await file.arrayBuffer(), 200, {
				...headers,
				"Content-Type": asset.mime_type,
			});
		});

		if (!disableDocs) {
			this.app.get("/", (c) => {
				// Keep any mount prefix (e.g. `/api` in the full-stack template).
				const base = c.req.path.endsWith("/") ? c.req.path.slice(0, -1) : c.req.path;
				return c.redirect(`${base}/docs/v${this.latestVersion}`);
			});
		} else {
			this.app.get("/", (c) => {
				return c.json({
					success: true,
					code: 200,
					message: `${AppConstants.APP_NAME} API is running. Documentation is disabled.`,
					data: null,
				});
			});
		}
	}

	static async start(port: number, hostname: string) {
		if (!this.app) {
			throw new Error(`${AppConstants.APP_NAME} API not initialized. Call API.init() first.`);
		}

		this.server = Bun.serve({ port, hostname, fetch: this.app.fetch });

		const serverHostnameStr = this.server.hostname?.includes(":")
			? `[${this.server.hostname}]`
			: this.server.hostname;

		Logger.log(
			`${AppConstants.APP_NAME} API listening on ${this.server.protocol}://${serverHostnameStr}:${this.server.port}`,
		);
	}

	static async stop() {
		if (this.server) {
			this.server.stop();
			Logger.log(`${AppConstants.APP_NAME} API server stopped.`);
		}
	}

	static getApp(): Hono {
		if (!this.app) {
			throw new Error(`${AppConstants.APP_NAME} API not initialized. Call API.init() first.`);
		}
		return this.app;
	}
}
