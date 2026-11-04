import { ConfigHandler } from "../../utils/config";
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
	protected static readonly defaultFetcher: ModrinthAPI.Fetcher = (input, init) => fetch(input, init);
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
			return { ok: false, status: jar.status, message: `Could not download the jar (status ${jar.status})` };
		}
		const bytes = await jar.arrayBuffer();

		const form = new FormData();
		form.append(
			"data",
			JSON.stringify({	
				project_id: config.MODRINTH_PROJECT_ID,
				name: input.name,
				version_number: input.versionNumber,
				version_body: input.changelog,
				version_type: input.versionType,
				loaders: ["fabric"],
				game_versions: input.gameVersions,
				dependencies: [],
				featured: false,
			}),
		);
		form.append(
			"file",
			new Blob([bytes]),
			`leicraftclient-${input.versionNumber}.jar`,
		);

		let res: Response;
		try {
			res = await this.fetcher(`${config.MODRINTH_URL.replace(/\/+$/, "")}/version`, {
				method: "POST",
				headers: { Authorization: config.MODRINTH_TOKEN },
				body: form,
				signal: AbortSignal.timeout(ModrinthAPI.UPLOAD_TIMEOUT_MS),
			});
		} catch (err: any) {
			Logger.warn("Modrinth publish failed:", err?.message ?? err);
			return { ok: false, status: 0, message: "Could not reach Modrinth" };
		}

		const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

		if (!res.ok) {
			const message = typeof body?.error === "string" ? body.error : `Modrinth responded with ${res.status}`;

			// A retried publish of the same version is not an error: resolve the existing one.
			if (res.status === 400 || res.status === 409) {
				const existing = await this.getVersionByNumber(input.versionNumber);
				if (existing.ok) return existing;
			}
			return { ok: false, status: res.status, message };
		}

		const id = typeof body?.id === "string" ? body.id : null;
		const url =
			typeof body?.page_url === "string"
				? body.page_url
				: id
					? `https://modrinth.com/version/${id}`
					: null;
		if (!id || !url) {
			return { ok: false, status: 0, message: "Modrinth did not return the created version" };
		}
		return { ok: true, data: { id, url } };
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
			res = await this.fetcher(
				`${config.MODRINTH_URL.replace(/\/+$/, "")}/project/${encodeURIComponent(config.MODRINTH_PROJECT_ID)}/version?number=${encodeURIComponent(versionNumber)}`,
				{
					headers: { Authorization: config.MODRINTH_TOKEN },
					signal: AbortSignal.timeout(ModrinthAPI.REQUEST_TIMEOUT_MS),
				},
			);
		} catch (err: any) {
			return { ok: false, status: 0, message: `Could not reach Modrinth: ${err?.message ?? err}` };
		}

		if (!res.ok) {
			return { ok: false, status: res.status, message: `Modrinth responded with ${res.status}` };
		}

		const body = (await res.json().catch(() => null)) as unknown;
		const version = Array.isArray(body) ? body.at(0) : body;
		if (
			typeof version !== "object" ||
			version === null ||
			typeof (version as any).id !== "string" ||
			typeof (version as any).page_url !== "string"
		) {
			return { ok: false, status: 404, message: "No Modrinth version with that number" };
		}
		return { ok: true, data: { id: (version as any).id, url: (version as any).page_url } };
	}
}

export namespace ModrinthAPI {
	export const REQUEST_TIMEOUT_MS = 15_000;
	export const DOWNLOAD_TIMEOUT_MS = 60_000;
	export const UPLOAD_TIMEOUT_MS = 60_000;

	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	export type Result<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

	/** Modrinth version types; pre-release mod versions are published as beta. */
	export type VersionType = "release" | "beta" | "alpha";

	export interface CreatedVersion {
		id: string;
		url: string;
	}
}