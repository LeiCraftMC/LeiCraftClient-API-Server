import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { ConfigHandler } from "../../utils/config";

/**
 * In-memory fixed-window rate limiter (per process), the same approach as the login limiter of
 * the template. Counters are incremented before checking, so concurrent requests can't race
 * past the limit.
 */
export class RateLimiter {
	protected readonly entries = new Map<string, { count: number; resetAt: number }>();

	constructor(
		readonly maxAttempts: number,
		readonly windowMs: number,
	) {
		const cleanup = setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.entries) {
				if (entry.resetAt <= now) this.entries.delete(key);
			}
		}, windowMs);
		// Allow the process to exit without waiting for this interval
		cleanup.unref();
	}

	/** Counts one attempt for `key`. */
	hit(key: string): RateLimiter.Result {
		const now = Date.now();

		let entry = this.entries.get(key);
		if (!entry || entry.resetAt <= now) {
			entry = { count: 0, resetAt: now + this.windowMs };
			this.entries.set(key, entry);
		}
		entry.count += 1;

		if (entry.count > this.maxAttempts) {
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
			};
		}

		return { allowed: true, retryAfterSeconds: 0 };
	}

	clear(key: string) {
		this.entries.delete(key);
	}
}

export namespace RateLimiter {
	export type Result = { allowed: boolean; retryAfterSeconds: number };
}

export class RequestUtils {
	/**
	 * Best-effort client IP: the last `X-Forwarded-For` entry when LCC_API_TRUST_PROXY is true —
	 * the one the trusted reverse proxy appended; earlier entries are client-controlled — otherwise
	 * the socket address from Bun. Returns "unknown" when neither is available (in-process tests).
	 */
	static getClientIP(c: Context) {
		if (ConfigHandler.getConfig()?.API_TRUST_PROXY) {
			const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
			if (forwarded) {
				return forwarded;
			}
		}

		try {
			return getConnInfo(c).remote.address ?? "unknown";
		} catch {
			return "unknown";
		}
	}
}
