import { ConfigHandler } from "../../utils/config";
import { Logger } from "../../utils/logger";

/**
 * GitLab API v4 client for the mod's releases on git.leicraftmc.de (project from
 * `GITLAB_PROJECT_ID`). Creating a release pushes its tag, which starts the build pipeline that
 * uploads the jar to the project's generic package registry and attaches it to the release as an
 * asset link — that link is the download the website serves.
 *
 * Auth is a personal access token with fine-grained scopes (`GITLAB_TOKEN`), used server-side
 * only. The project is public, so downloads of the package registry work without it.
 */
export class GitLabAPI {
	protected static readonly defaultFetcher: GitLabAPI.Fetcher = (input, init) => fetch(input, init);
	protected static fetcher: GitLabAPI.Fetcher = GitLabAPI.defaultFetcher;

	/** Replace the HTTP client (tests). `null` restores the real `fetch`. */
	static setFetcher(fetcher: GitLabAPI.Fetcher | null) {
		this.fetcher = fetcher ?? this.defaultFetcher;
	}

	static isConfigured() {
		return Boolean(ConfigHandler.getConfig()?.GITLAB_TOKEN);
	}

	/**
	 * Creates a release. Its `tag_name` tag does not exist yet, so GitLab creates it from `ref`
	 * (`GITLAB_RELEASE_REF`, the default branch) — that tag push starts the release pipeline.
	 */
	static async createRelease(input: {
		tag: string;
		name: string;
		description: string;
	}): Promise<GitLabAPI.Result<GitLabAPI.Release>> {
		return this.request<GitLabAPI.Release>("/releases", {
			method: "POST",
			body: JSON.stringify({
				tag_name: input.tag,
				ref: ConfigHandler.getConfig()?.GITLAB_RELEASE_REF,
				name: input.name,
				description: input.description,
			}),
		});
	}

	/** The release of a tag, or a not-found result. */
	static async getRelease(tag: string): Promise<GitLabAPI.Result<GitLabAPI.Release>> {
		return this.request<GitLabAPI.Release>(`/releases/${encodeURIComponent(tag)}`);
	}

	/** The newest releases first; what the import picker on the dashboard lists. */
	static async listReleases(perPage = 20): Promise<GitLabAPI.Result<GitLabAPI.Release[]>> {
		return this.request<GitLabAPI.Release[]>(`/releases?per_page=${perPage}`);
	}

	/** Replaces a release's notes, e.g. after an admin edited the changelog. Best effort. */
	static async updateReleaseNotes(tag: string, description: string): Promise<boolean> {
		const result = await this.request<GitLabAPI.Release>(`/releases/${encodeURIComponent(tag)}`, {
			method: "PUT",
			body: JSON.stringify({ description }),
		});
		if (!result.ok) {
			Logger.warn(`Could not update the GitLab release notes of ${tag}: ${result.message}`);
			return false;
		}
		return true;
	}

	/** The newest pipeline of a ref, e.g. the tag of a release. */
	static async getPipelineForRef(ref: string): Promise<GitLabAPI.Result<GitLabAPI.Pipeline>> {
		const result = await this.request<GitLabAPI.Pipeline[]>(
			`/pipelines?ref=${encodeURIComponent(ref)}`,
		);
		if (!result.ok) return result;
		const newest = result.data.at(0);
		if (!newest) return { ok: false, status: 404, message: `No pipeline for ${ref}` };
		return { ok: true, data: newest };
	}

	/** Raw content of a file at a ref, e.g. `gradle.properties` of a release tag. */
	static async getFile(path: string, ref: string): Promise<GitLabAPI.Result<string>> {
		const result = await this.request<string>(
			`/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
			{ parse: "text" },
		);
		return result;
	}

	/** The jar asset link the release pipeline attaches, or null while the build has not finished. */
	static jarAssetLinkOf(release: GitLabAPI.Release): GitLabAPI.AssetLink | null {
		const jarLinks = release.assets?.links?.filter((link) => link.name.endsWith(".jar")) ?? [];
		// the release pipeline uploads `leicraftclient-<version>.jar` as link_type "package"
		return jarLinks.find((link) => link.link_type === "package") ?? jarLinks.at(0) ?? null;
	}

	private static async request<T>(
		path: string,
		init?: {
			method?: string;
			body?: string;
			parse?: "json" | "text";
		},
	): Promise<GitLabAPI.Result<T>> {
		const config = ConfigHandler.getConfig();
		if (!config?.GITLAB_TOKEN) {
			return { ok: false, status: 503, message: "The GitLab integration is not configured" };
		}

		let res: Response;
		try {
			res = await this.fetcher(
				`${config.GITLAB_API_BASE_URL.replace(/\/+$/, "")}/projects/${config.GITLAB_PROJECT_ID}${path}`,
				{
					method: init?.method ?? "GET",
					headers: {
						"PRIVATE-TOKEN": config.GITLAB_TOKEN,
						...(init?.body ? { "Content-Type": "application/json" } : {}),
					},
					body: init?.body,
					signal: AbortSignal.timeout(GitLabAPI.REQUEST_TIMEOUT_MS),
				},
			);
		} catch (err: any) {
			Logger.warn(`GitLab request ${path} failed:`, err?.message ?? err);
			return { ok: false, status: 0, message: "Could not reach GitLab" };
		}

		const body = init?.parse === "text" ? await res.text() : await res.json().catch(() => null);
		if (!res.ok) {
			const message =
				typeof body === "object" && body !== null && typeof (body as any).message === "string"
					? (body as any).message
					: `GitLab responded with ${res.status}`;
			Logger.debug(`GitLab request ${path} failed with ${res.status}: ${message}`);
			return { ok: false, status: res.status, message };
		}

		return { ok: true, data: body as T };
	}
}

export namespace GitLabAPI {
	export const REQUEST_TIMEOUT_MS = 15_000;

	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

	export type Result<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

	/** GitLab release (`GET /projects/:id/releases/:tag`), trimmed to what is used. */
	export interface Release {
		tag_name: string;
		name: string;
		description: string;
		released_at: string;
		assets: {
			links: AssetLink[];
		};
	}

	/** A GitLab release asset link, e.g. the jar the release pipeline attaches. */
	export interface AssetLink {
		id: number;
		name: string;
		url: string;
		direct_asset_url: string;
		link_type: string | null;
	}

	/** GitLab pipeline, trimmed to what is used. */
	export interface Pipeline {
		id: number;
		status: string;
		web_url: string;
	}
}
