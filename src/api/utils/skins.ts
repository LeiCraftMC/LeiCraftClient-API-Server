import { Logger } from "../../utils/logger";
import { PNGInfo } from "../../utils/png";

/**
 * Serves the Minecraft skins of known accounts from Mojang's texture server with CORS, so the
 * website's 3D viewer needs no third-party skin service. Only `textures.minecraft.net` URLs (from
 * the Mojang-signed profile the mod handshake stored) are fetched; responses are cached in memory.
 */
export class SkinProxy {
	static readonly ALLOWED_HOST = "textures.minecraft.net";
	static readonly MAX_SKIN_BYTES = 256 * 1024;
	static readonly MAX_CACHE_ENTRIES = 1000;
	static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
	static readonly FETCH_TIMEOUT_MS = 5000;

	protected static fetcher: SkinProxy.Fetcher = (input, init) => fetch(input, init);
	protected static readonly cache = new Map<string, { bytes: Uint8Array; fetched_at: number }>();

	/** Replace the HTTP client (tests). `null` restores the real `fetch`. */
	static setFetcher(fetcher: SkinProxy.Fetcher | null) {
		this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
		this.cache.clear();
	}

	/** The https URL to fetch, or null if the stored URL is not a Mojang texture URL. */
	static normalizeURL(skinURL: string) {
		try {
			const url = new URL(skinURL);
			if (url.hostname !== this.ALLOWED_HOST || !/^\/texture\/[0-9a-f]+$/.test(url.pathname)) {
				return null;
			}
			return `https://${this.ALLOWED_HOST}${url.pathname}`;
		} catch {
			return null;
		}
	}

	/** The skin PNG, or null if it can't be fetched or is not a valid skin image. */
	static async get(skinURL: string): Promise<Uint8Array | null> {
		const url = this.normalizeURL(skinURL);
		if (!url) {
			return null;
		}

		const cached = this.cache.get(url);
		if (cached && cached.fetched_at + this.CACHE_TTL_MS > Date.now()) {
			// refresh the LRU position
			this.cache.delete(url);
			this.cache.set(url, cached);
			return cached.bytes;
		}

		let bytes: Uint8Array;
		try {
			const res = await this.fetcher(url, { signal: AbortSignal.timeout(this.FETCH_TIMEOUT_MS) });
			if (!res.ok) {
				return null;
			}
			bytes = new Uint8Array(await res.arrayBuffer());
		} catch (error: any) {
			Logger.warn(`Skin download failed (${url}):`, error?.message || error);
			return null;
		}

		if (bytes.byteLength > this.MAX_SKIN_BYTES) {
			return null;
		}
		const png = PNGInfo.parse(bytes);
		// 64×64 (or legacy 64×32) at any multiple
		if (!png.ok || png.header.width % 64 !== 0 || png.header.width > 1024) {
			return null;
		}

		this.cache.set(url, { bytes, fetched_at: Date.now() });
		while (this.cache.size > this.MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}

		return bytes;
	}
}

export namespace SkinProxy {
	export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
}
