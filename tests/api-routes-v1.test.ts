import { describe, expect, test } from "bun:test";
import { API } from "../src/api";
import { ConfigHandler } from "../src/utils/config";
import { AppConstants } from "../src/utils/constants";
import { makeAPIRequest } from "./helpers/api";

describe("Global API routes", async () => {
	test("GET /health returns API health payload", async () => {
		const res = await API.getApp().request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as any;
		expect(body.success).toBe(true);
		expect(body.message).toBe(`${AppConstants.APP_NAME} API is running`);
	});

	test("GET / redirects to the latest docs while docs are enabled", async () => {
		const res = await API.getApp().request("/");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/docs/v1");
	});

	test("every operation tag is declared and every declared tag is used", async () => {
		const res = await API.getApp().request("/docs/v1/openapi");
		const spec = (await res.json()) as any;

		const declared = new Set<string>(spec.tags.map((tag: any) => tag.name));
		const used = new Set<string>();
		for (const operations of Object.values<any>(spec.paths)) {
			for (const operation of Object.values<any>(operations)) {
				for (const tag of operation.tags ?? []) used.add(tag);
			}
		}

		expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
		expect([...declared].filter((tag) => !used.has(tag))).toEqual([]);
	});

	test("every path parameter of the spec is declared on its operation", async () => {
		const res = await API.getApp().request("/docs/v1/openapi");
		const spec = (await res.json()) as any;

		const problems: string[] = [];
		for (const [path, operations] of Object.entries<any>(spec.paths)) {
			const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
			if (new Set(names).size !== names.length) {
				problems.push(`${path}: duplicate path parameter`);
			}
			for (const [method, operation] of Object.entries<any>(operations)) {
				const declared = new Set(
					(operation.parameters ?? [])
						.filter((parameter: any) => parameter.in === "path")
						.map((parameter: any) => parameter.name),
				);
				for (const name of names) {
					if (!declared.has(name)) problems.push(`${method.toUpperCase()} ${path}: ${name}`);
				}
			}
		}

		expect(problems).toEqual([]);
	});

	test("unknown asset files are 404 envelopes", async () => {
		await makeAPIRequest(`/assets/${"0".repeat(64)}.png`, {}, 404);
		await makeAPIRequest("/assets/not-a-hash.png", {}, 404);
	});
});

describe("Docs Routes", async () => {
	test("GET /docs/v1/openapi returns API docs if enabled", async () => {
		await makeAPIRequest("/docs/v1/openapi", {}, 200);
	});

	test("GET /docs/v1 returns API docs UI if enabled", async () => {
		await makeAPIRequest("/docs/v1", {}, 200);
	});

	test("docs are not served when disabled", async () => {
		await API.init([], true);

		await makeAPIRequest("/docs/v1/openapi", {}, 404);
		await makeAPIRequest("/docs/v1", {}, 404);

		// restore the normal app for the other test files
		await API.init([ConfigHandler.getConfig()?.APP_URL as string], false);
		await makeAPIRequest("/docs/v1/openapi", {}, 200);
	});
});
