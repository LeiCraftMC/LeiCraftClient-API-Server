import { ConfigHandler } from "../../utils/config";
import { AppConstants } from "../../utils/constants";
import { Logger } from "../../utils/logger";

/**
 * Modrinth API v2 client for auto-publishing released jars (the "Auto-publish to Modrinth"
 * checkbox on the dashboard, on by default). A publish downloads the jar from its GitLab package
 * registry URL, hashes it and uploads it as a new version of the configured project
 * (`MODRINTH_PROJECT_ID`), with the release changelog as the version body. The token
 * (`MODRINTH_TOKEN`) is created on the project's Modrinth settings page and is limited to it;
 * it stays server-side.
 */
export class ModrinthAPI {
	protected static readonly defaultFetcher: ModrinthAPI.Fetcher = (input, init) =>
		fetch(input, init);
	protected static fetcher: ModrinthAPI.Fetcher = ModrinthAPI.defaultFetcher;

	/** Replace the HTTP client (tests). `null` restores the real `fetch`. */
	static setFetcher(fetcher: ModrinthAPI.Fetcher | null) {
		this.fetcher = fetcher ?? this.defaultFetcher;
	}

	static isConfigured() {
		const config = ConfigHandler.getConfig();
		return Boolean(config?.MODRINTH_TOKEN && config?.MODRINTH_PROJECT_ID);
	}

	/**
	 * Publishes the jar behind `jarURL` (the release's GitLab package registry permalink) as a new
	 * version. A version number that exists on the project already is resolved to that version
	 * instead of failing — retries and overlapping publishes stay idempotent.
	 */
	static async publishVersion(input: {
		versionNumber: string;
		name: string;
		changelog: string;
		gameVersions: string[];
		versionType: ModrinthAPI.VersionType;
		jarURL: string;
	}): Promise<ModrinthAPI.Result<ModrinthAPI.CreatedVersion>> {
		const config = ConfigHandler.getConfig();
		if (!config?.MODRINTH_TOKEN || !config.MODRINTH_PROJECT_ID) {
			return { ok: false, status: 503, message: "The Modrinth integration is not configured" };
		}

		let jar: Response;
		try {
			jar = await this.fetcher(input.jarURL, {
				signal: AbortSignal.timeout(ModrinthAPI.DOWNLOAD_TIMEOUT_MS),
			});
		} catch (err: any) {
			return { ok: false, status: 0, message: `Could not download the jar: ${err?.message ?? err}` };
		}
		if (!jar.ok) {
			return {
				ok: false,
				status: jar.status,
				message: `Could not download the jar (status ${jar.status})`,
			};
		}
		const bytes = await jar.arrayBuffer();

		const form = new FormData();
		form.append(
			"data",
			JSON.stringify({
				project_id: config.MODRINTH_PROJECT_ID,
				name: input.name,
				version_number: input.versionNumber,
				changelog: input.changelog,
				version_type: input.versionType,
				loaders: ["fabric"],
				game_versions: input.gameVersions,
				dependencies: [],
				featured: false,
				// Modrinth rejects a file part that is not listed here
				file_parts: [ModrinthAPI.JAR_FILE_PART],
				primary_file: ModrinthAPI.JAR_FILE_PART,
			}),
		);
		form.append(
			ModrinthAPI.JAR_FILE_PART,
			new Blob([bytes]),
			`leicraftclient-${input.versionNumber}.jar`,
		);

		let res: Response;
		try {
			res = await this.fetcher(`${config.MODRINTH_URL.replace(/\/+$/, "")}/version`, {
				method: "POST",
				headers: this.headers(config.MODRINTH_TOKEN),
				body: form,
				signal: AbortSignal.timeout(ModrinthAPI.UPLOAD_TIMEOUT_MS),
			});
		} catch (err: any) {
			Logger.warn("Modrinth publish failed:", err?.message ?? err);
			return { ok: false, status: 0, message: "Could not reach Modrinth" };
		}

		const body = (await res.json().catch(() => null)) as unknown;

		if (!res.ok) {
			// A retried publish of the same version is not an error: Modrinth refuses the jar as a
			// duplicate file, so resolve the version that is already there.
			if (res.status === 400 || res.status === 409) {
				const existing = await this.getVersionByNumber(input.versionNumber);
				if (existing.ok) return existing;
			}
			return { ok: false, status: res.status, message: this.errorMessageOf(body, res.status) };
		}

		const created = this.createdVersionOf(body, config.MODRINTH_PROJECT_ID);
		if (!created) {
			return { ok: false, status: 0, message: "Modrinth did not return the created version" };
		}
		return { ok: true, data: created };
	}

	/** The version of this project with exactly this version number, e.g. to resolve duplicates. */
	static async getVersionByNumber(
		versionNumber: string,
	): Promise<ModrinthAPI.Result<ModrinthAPI.CreatedVersion>> {
		const config = ConfigHandler.getConfig();
		if (!config?.MODRINTH_TOKEN || !config.MODRINTH_PROJECT_ID) {
			return { ok: false, status: 503, message: "The Modrinth integration is not configured" };
		}

		let res: Response;
		try {
			// `/project/:id/version/:id|number` — the oldest version, should several share the number
			res = await this.fetcher(
				`${config.MODRINTH_URL.replace(/\/+$/, "")}/project/${encodeURIComponent(config.MODRINTH_PROJECT_ID)}/version/${encodeURIComponent(versionNumber)}`,
				{
					headers: this.headers(config.MODRINTH_TOKEN),
					signal: AbortSignal.timeout(ModrinthAPI.REQUEST_TIMEOUT_MS),
				},
			);
		} catch (err: any) {
			return { ok: false, status: 0, message: `Could not reach Modrinth: ${err?.message ?? err}` };
		}

		const body = (await res.json().catch(() => null)) as unknown;
		if (!res.ok && res.status !== 404) {
			return { ok: false, status: res.status, message: this.errorMessageOf(body, res.status) };
		}

		// the path also matches a version id, so only take a version with exactly this number
		const version = res.ok ? this.createdVersionOf(body, config.MODRINTH_PROJECT_ID) : null;
		if (!version || (body as { version_number?: unknown }).version_number !== versionNumber) {
			return { ok: false, status: 404, message: "No Modrinth version with that number" };
		}
		return { ok: true, data: version };
	}

	/** Every Modrinth call; Modrinth asks for a User-Agent that identifies the app. */
	private static headers(token: string) {
		return { Authorization: token, "User-Agent": ModrinthAPI.USER_AGENT };
	}

	/** Modrinth errors are `{ error: "invalid_input", description: "…" }`; the description says why. */
	private static errorMessageOf(body: unknown, status: number): string {
		const error = (body ?? {}) as { error?: unknown; description?: unknown };
		if (typeof error.description === "string" && error.description) return error.description;
		if (typeof error.error === "string" && error.error) return error.error;
		return `Modrinth responded with ${status}`;
	}

	/**
	 * A version object (created or looked up) as its id and its page on modrinth.com — the API
	 * returns no web URL, so it is built from the project and the version id.
	 */
	private static createdVersionOf(
		body: unknown,
		fallbackProjectID: string,
	): ModrinthAPI.CreatedVersion | null {
		const version = (body ?? {}) as { id?: unknown; project_id?: unknown };
		if (typeof version.id !== "string") return null;

		const projectID = typeof version.project_id === "string" ? version.project_id : fallbackProjectID;
		return {
			id: version.id,
			url: `${ModrinthAPI.WEBSITE_URL}/mod/${encodeURIComponent(projectID)}/version/${encodeURIComponent(version.id)}`,
		};
	}
}

export namespace ModrinthAPI {
	export const REQUEST_TIMEOUT_MS = 15_000;
	export const DOWNLOAD_TIMEOUT_MS = 60_000;
	export const UPLOAD_TIMEOUT_MS = 60_000;

	/** Modrinth wants a User-Agent that names the app and a way to reach its maintainers. */
	export const USER_AGENT = `LeiCraftMC/${AppConstants.BINARY_NAME} (${AppConstants.APP_API_DEFAULT_PROD_URL})`;

	/** Multipart field of the jar, listed in the version's `file_parts`. */
	export const JAR_FILE_PART = "file";

	/** Version pages live here, not on the API host. */
	export const WEBSITE_URL = "https://modrinth.com";

	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	export type Result<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

	/** Modrinth version types; pre-release mod versions are published as beta. */
	export type VersionType = "release" | "beta" | "alpha";

	export interface CreatedVersion {
		id: string;
		url: string;
	}
}
