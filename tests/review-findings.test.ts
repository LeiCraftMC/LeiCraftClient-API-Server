import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { API } from "../src/api";
import { AssetValidator } from "../src/api/utils/assets";
import { MaintenanceTasks } from "../src/api/utils/maintenance";
import { DB } from "../src/db";
import { makeAPIRequest } from "./helpers/api";
import { uploadAsset, uploadAssetRaw } from "./helpers/flows";
import { createModel, createPNG } from "./helpers/png";
import {
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedUser,
	seedUserWithSession,
} from "./helpers/seed";

// Regression tests for the issues found in the security review of the first API version.

describe("Takedowns freeze the content", () => {
	test("restore returns a product to its status before the takedown", async () => {
		const moderator = await seedUserWithSession("moderator");
		const owner = await seedUserWithSession();
		const page = await seedPage("community", owner.user.id);

		for (const status of ["pending_review", "rejected", "draft", "published"] as const) {
			const { product } = await seedProduct(page.id, "cape", { status });

			await makeAPIRequest(`/v1/moderation/products/${product.id}/disable`, {
				method: "POST",
				authToken: moderator.token,
				body: { reason: "reported" },
			});

			const restored = await makeAPIRequest(`/v1/moderation/products/${product.id}/restore`, {
				method: "POST",
				authToken: moderator.token,
			});
			expect(restored.product.status).toBe(status);
		}
	});

	test("disabled products can't be edited (no swapping content before a restore)", async () => {
		const moderator = await seedUserWithSession("moderator");
		const owner = await seedUserWithSession();
		const page = await seedPage("community", owner.user.id);
		const { product } = await seedProduct(page.id, "cosmetic", { status: "pending_review" });

		await makeAPIRequest(`/v1/moderation/products/${product.id}/disable`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "reported" },
		});

		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/products/${product.id}`,
			{ method: "PUT", authToken: owner.token, body: { name: "Swapped" } },
			403,
		);

		const model = await uploadAsset(
			owner.token,
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(createModel({ credit: "swap" }))),
		);
		const texture = await uploadAsset(
			owner.token,
			"cosmetic_texture",
			createPNG(16, 16, [1, 1, 1, 255]),
		);
		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/products/${product.id}/variants`,
			{
				method: "POST",
				authToken: owner.token,
				body: {
					name: "Swap",
					model_asset_id: model.asset.id,
					texture_asset_id: texture.asset.id,
				},
			},
			403,
		);
	});
});

describe("Ban rules", () => {
	test("moderators can't unban staff; admins can", async () => {
		const admin = await seedUserWithSession("admin");
		const moderator = await seedUserWithSession("moderator");
		const bannedModerator = await seedUser("moderator");

		await makeAPIRequest(`/v1/moderation/users/${bannedModerator.id}/ban`, {
			method: "POST",
			authToken: admin.token,
			body: { reason: "abuse" },
		});
		await makeAPIRequest(
			`/v1/moderation/users/${bannedModerator.id}/unban`,
			{ method: "POST", authToken: moderator.token },
			403,
		);
		await makeAPIRequest(`/v1/moderation/users/${bannedModerator.id}/unban`, {
			method: "POST",
			authToken: admin.token,
		});
	});
});

describe("Exclusive files stay with their page", () => {
	test("another page can't reuse the texture of an exclusive cape", async () => {
		const official = await seedPage("official", null);
		const { product: exclusive } = await seedProduct(official.id, "cape", {
			availability: "exclusive",
		});

		const partner = await seedUserWithSession();
		const partnerPage = await seedPage("partner", partner.user.id);

		// by id …
		await makeAPIRequest(
			`/v1/studio/pages/${partnerPage.id}/products`,
			{
				method: "POST",
				authToken: partner.token,
				body: { type: "cape", name: "Copy", texture_asset_id: exclusive.texture_asset_id },
			},
			400,
		);

		// … and by uploading the same bytes again (same SHA-256 → same asset id)
		const download = await API.getApp().request(`/assets/${exclusive.texture_asset_id}.png`);
		const copy = await uploadAsset(
			partner.token,
			"cape_texture",
			new Uint8Array(await download.arrayBuffer()),
		);
		expect(copy.asset.id).toBe(exclusive.texture_asset_id as string);

		await makeAPIRequest(
			`/v1/studio/pages/${partnerPage.id}/products`,
			{
				method: "POST",
				authToken: partner.token,
				body: { type: "cape", name: "Copy", texture_asset_id: copy.asset.id },
			},
			400,
		);

		// the page that owns the exclusive may reuse it
		await makeAPIRequest(`/v1/studio/pages/${official.id}/products`, {
			method: "POST",
			authToken: (await seedUserWithSession("admin")).token,
			body: { type: "cape", name: "Variant", texture_asset_id: copy.asset.id },
		});
	});
});

describe("Model uploads", () => {
	test("deeply nested models are rejected with 400, not a crash", async () => {
		const user = await seedUserWithSession();
		await seedPage("community", user.user.id);

		let node: any = { boxes: [] };
		for (let i = 0; i < 5000; i++) node = { submodel: node };
		const model = createModel({ models: [{ attachTo: "head", ...node }] });

		const res = await uploadAssetRaw(
			user.token,
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(model)),
		);
		expect(res.status).toBe(400);
	});

	test("unknown keys are removed from stored models", () => {
		const model = createModel();
		(model.models[0] as any).texture = "https://tracker.example/pixel.png";
		(model.models[0] as any).submodels[0].custom = { url: "https://tracker.example" };
		(model as any).tracking = "https://tracker.example";

		const result = AssetValidator.validate(
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(model)),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const stored = new TextDecoder().decode(result.asset.bytes);
		expect(stored).not.toContain("tracker.example");
		expect(result.asset.warnings.some((warning) => warning.includes("tracking"))).toBe(true);
	});

	test("the raw nesting check ignores brackets inside strings", () => {
		expect(AssetValidator.getJSONDepth('{"a":"[[[[{{{{"}')).toBe(1);
		expect(AssetValidator.getJSONDepth('{"a":"\\"[","b":[[1]]}')).toBe(3);
	});
});

describe("Assets and cleanup", () => {
	test("uploading old bytes again restarts the cleanup grace period", async () => {
		const user = await seedUserWithSession();
		await seedPage("community", user.user.id);
		const bytes = createPNG(48, 48, [42, 42, 42, 255]);

		const first = await uploadAsset(user.token, "image", bytes);
		await DB.instance()
			.update(DB.Tables.assets)
			.set({ created_at: Date.now() - MaintenanceTasks.ORPHAN_ASSET_GRACE_MS - 1000 })
			.where(eq(DB.Tables.assets.id, first.asset.id));

		await uploadAsset(user.token, "image", bytes);
		await MaintenanceTasks.cleanupOrphanAssets();

		await makeAPIRequest(new URL(first.asset.url).pathname, {}, 200);
	});
});

describe("Inventory privacy", () => {
	test("owned but unavailable products come without files", async () => {
		const page = await seedPage("partner", null);
		const { product } = await seedProduct(page.id, "cape", {
			availability: "exclusive",
			status: "draft",
		});
		const owner = await seedUserWithSession();
		await DB.instance()
			.insert(DB.Tables.userItems)
			.values({ user_id: owner.user.id, product_id: product.id, source: "grant" });

		const [item] = await makeAPIRequest("/v1/account/inventory", { authToken: owner.token });
		expect(item.available).toBe(false);
		expect(item.product.texture).toBeNull();
		expect(item.product.name).toBe(product.name);
	});
});

describe("Page members", () => {
	test("the last owner can't be removed or demoted by members; admins can", async () => {
		const owner = await seedUserWithSession();
		const page = await seedPage("partner", owner.user.id);

		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/members/${owner.user.id}`,
			{ method: "PUT", authToken: owner.token, body: { role: "manager" } },
			409,
		);
		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/members/${owner.user.id}`,
			{ method: "DELETE", authToken: owner.token },
			409,
		);

		const admin = await seedUserWithSession("admin");
		await makeAPIRequest(`/v1/studio/pages/${page.id}/members/${owner.user.id}`, {
			method: "DELETE",
			authToken: admin.token,
		});
	});
});

describe("Grants", () => {
	test("an ambiguous Minecraft name is refused", async () => {
		const partner = await seedUserWithSession();
		const page = await seedPage("partner", partner.user.id);
		const { product } = await seedProduct(page.id, "cape", { availability: "exclusive" });

		// a renamed account keeps its old stored name until it verifies again
		await seedMinecraftAccount((await seedUser()).id, { name: "SharedName" });
		await seedMinecraftAccount((await seedUser()).id, { name: "sharedname" });

		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/products/${product.id}/owners`,
			{ method: "POST", authToken: partner.token, body: { minecraft_name: "SharedName" } },
			409,
		);
	});

	test("a published cape keeps its texture", async () => {
		const partner = await seedUserWithSession();
		const page = await seedPage("partner", partner.user.id);
		const { product } = await seedProduct(page.id, "cape");

		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/products/${product.id}`,
			{ method: "PUT", authToken: partner.token, body: { texture_asset_id: null } },
			400,
		);
	});
});

describe("Audit log", () => {
	test("partner studio actions are logged", async () => {
		const admin = await seedUserWithSession("admin");
		const partner = await seedUserWithSession();
		const page = await seedPage("partner", partner.user.id);

		const product = await makeAPIRequest(`/v1/studio/pages/${page.id}/products`, {
			method: "POST",
			authToken: partner.token,
			body: { type: "cape", name: "Logged" },
		});
		await makeAPIRequest(`/v1/studio/pages/${page.id}/products/${product.id}`, {
			method: "PUT",
			authToken: partner.token,
			body: { description: "changed" },
		});

		const log = await makeAPIRequest(
			`/v1/admin/audit-logs?target_type=product&target_id=${product.id}`,
			{ authToken: admin.token },
		);
		expect(log.map((entry: any) => entry.action).sort()).toEqual([
			"product.create",
			"product.update",
		]);
	});
});
