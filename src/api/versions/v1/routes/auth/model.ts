import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { DB } from "../../../../../db";

/**
 * Internal website path: starts with a single `/`, then only URL-safe characters — no `\`,
 * whitespace or control characters, which browsers would turn into `//other-host`.
 */
const RedirectPath = z
	.string()
	.max(512)
	.regex(
		/^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/,
		"Must be an internal path starting with a single /",
	);

export namespace AuthModel.DiscordAuthorize {
	export const Body = z.object({
		redirect_path: RedirectPath.optional().describe(
			"Website path to return to after the login; handed back by the callback",
		),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = z.object({
		authorize_url: z.string().describe("Send the browser here"),
		state: z.string(),
		verifier: z
			.string()
			.describe(
				"Keep this in the browser that started the login (e.g. sessionStorage) — never in a URL — and send it with the callback. It stops an attacker's login link from logging the victim in.",
			),
		expires_at: z.number().int(),
	});
	export type Response = z.infer<typeof Response>;
}

export namespace AuthModel.DiscordCallback {
	export const Body = z.object({
		code: z.string().min(1).max(512).describe("The `code` query parameter Discord redirected with"),
		state: z.string().min(1).max(512).describe("The `state` query parameter Discord redirected with"),
		verifier: z
			.string()
			.min(1)
			.max(512)
			.describe("The `verifier` the authorize call returned, kept by the browser"),
	});
	export type Body = z.infer<typeof Body>;

	export const Response = createSelectSchema(DB.Tables.sessions)
		.omit({
			id: true,
			hashed_token: true,
		})
		.extend({
			token: z.string(),
			redirect_path: z.string().nullable(),
		});
	export type Response = z.infer<typeof Response>;
}

export namespace AuthModel.Session {
	export const Response = createSelectSchema(DB.Tables.sessions).omit({
		id: true,
		hashed_token: true,
	});
	export type Response = z.infer<typeof Response>;
}
