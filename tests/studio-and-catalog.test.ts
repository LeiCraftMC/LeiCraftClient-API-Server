import { beforeAll, describe, expect, test } from "bun:test";
import { API } from "../src/api";
import { CatalogModel } from "../src/api/versions/v1/routes/catalog/model";
import { StudioPagesModel } from "../src/api/versions/v1/routes/studio/pages/model";
import { StudioProductsModel } from "../src/api/versions/v1/routes/studio/pages/products/model";
import { makeAPIRequest } from "./helpers/api";
import { uploadAsset, uploadAssetRaw } from "./helpers/flows";
import { createModel, createPNG } from "./helpers/png";
import {
	seedClientSession,
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedUserWithSession,
} from "./helpers/seed";

type Session = Awaited<ReturnType<typeof seedUserWithSession>>;

async function createPage(token: string, body: Record<string, unknown>, expectedCode?: number) {
	return await makeAPIRequest(
		"/v1/studio/pages",
		{ method: "POST", authToken: token, body },
		expectedCode,
	);
}

let uniqueCounter = 0;
function slug(prefix: string) {
	uniqueCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${uniqueCounter}`;
}

describe("Asset uploads", () => {
	let user: Session;

	beforeAll(async () => {
		user = await seedUserWithSession();
		// uploads are for page members
		await seedPage("community", user.user.id);
	});

	test("accounts without a page can't upload", async () => {
		const pageless = await seedUserWithSession();
		const res = await uploadAssetRaw(pageless.token, "image", createPNG(16, 16));
		expect(res.status).toBe(403);
	});

	test("a valid cape texture is stored content-addressed", async () => {
		const bytes = createPNG(512, 256);
		const { asset, warnings } = await uploadAsset(user.token, "cape_texture", bytes);

		expect(asset.id).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
		expect(asset.url).toBe(`http://localhost:12550/assets/${asset.id}.png`);
		expect(asset.width).toBe(512);
		expect(asset.height).toBe(256);
		expect(warnings).toEqual([]);

		// identical upload → same asset
		const again = await uploadAsset(user.token, "cape_texture", bytes);
		expect(again.asset.id).toBe(asset.id);

		const res = await API.getApp().request(`/assets/${asset.id}.png`);
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

		const cached = await API.getApp().request(`/assets/${asset.id}.png`, {
			headers: { "If-None-Match": `"${asset.id}"` },
		});
		expect(cached.status).toBe(304);

		// wrong extension for the stored type
		await makeAPIRequest(`/assets/${asset.id}.json`, {}, 404);
	});

	test("cape textures must be 2:1 with a width that is a multiple of 64", async () => {
		for (const [width, height] of [
			[64, 64],
			[22, 17],
			[100, 50],
			[4096, 2048],
		] as const) {
			const res = await uploadAssetRaw(user.token, "cape_texture", createPNG(width, height));
			expect(res.status).toBe(400);
		}
	});

	test("broken or fake PNGs are rejected", async () => {
		const png = createPNG(64, 32);

		const truncated = png.slice(0, png.length - 10);
		expect((await uploadAssetRaw(user.token, "cape_texture", truncated)).status).toBe(400);

		const tampered = png.slice();
		tampered[40] = (tampered[40] ?? 0) ^ 0xff; // flips a byte inside a chunk → CRC mismatch
		expect((await uploadAssetRaw(user.token, "cape_texture", tampered)).status).toBe(400);

		const notAPNG = new TextEncoder().encode("<html>hello</html>");
		expect((await uploadAssetRaw(user.token, "image", notAPNG)).status).toBe(400);
	});

	test("cosmetic models are validated, minified and get warnings", async () => {
		const model = createModel({ texture: "assets/items/old/texture.png" });
		(model.models[0] as any).invertAxis = "xyz";

		const { asset, warnings } = await uploadAsset(
			user.token,
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(model, null, 4)),
		);
		expect(asset.mime_type).toBe("application/json");
		expect(warnings.some((warning) => warning.includes("invertAxis"))).toBe(true);
		expect(warnings.some((warning) => warning.includes('"texture"'))).toBe(true);

		const res = await API.getApp().request(new URL(asset.url).pathname);
		expect(res.headers.get("content-type")).toBe("application/json");
		const stored = (await res.json()) as any;
		expect(stored.texture).toBeUndefined();
		expect(stored.models[0].attachTo).toBe("head");
	});

	test("invalid cosmetic models are rejected", async () => {
		const invalid = [
			"not json at all",
			JSON.stringify({ models: [] }),
			JSON.stringify(createModel({ textureSize: undefined })),
			JSON.stringify(createModel({ models: [{ attachTo: "tail", boxes: [] }] })),
			JSON.stringify(
				createModel({
					models: [
						{
							attachTo: "head",
							boxes: [{ coordinates: [0, 0, 0, 1, 1, 1], uvNorth: [0, 0, 1, 1] }],
						},
					],
				}),
			),
		];

		for (const body of invalid) {
			const res = await uploadAssetRaw(user.token, "cosmetic_model", new TextEncoder().encode(body));
			expect(res.status).toBe(400);
		}
	});

	test("uploads need a user session or API key", async () => {
		const res = await API.getApp().request("/v1/studio/assets", { method: "POST" });
		expect(res.status).toBe(401);

		const account = await seedMinecraftAccount(null);
		const client = await seedClientSession(account.id);
		expect((await uploadAssetRaw(client.token, "image", createPNG(16, 16))).status).toBe(401);
	});
});

describe("Pages", () => {
	test("a user can create exactly one community page", async () => {
		const user = await seedUserWithSession();

		const page = await createPage(user.token, {
			category: "community",
			slug: slug("my-capes"),
			name: "My Capes",
		});
		expect(StudioPagesModel.StudioPage.parse(page).member_role).toBe("owner");

		await createPage(user.token, { category: "community", slug: slug("second"), name: "Again" }, 409);
	});

	test("only admins create official and partner pages", async () => {
		const user = await seedUserWithSession();
		await createPage(user.token, { category: "partner", slug: slug("p"), name: "Nope" }, 403);
		await createPage(user.token, { category: "official", slug: slug("o"), name: "Nope" }, 403);

		const admin = await seedUserWithSession("admin");
		const partner = await createPage(admin.token, {
			category: "partner",
			slug: slug("partner"),
			name: "Partner",
			owner_user_id: user.user.id,
		});
		expect(partner.member_role).toBeNull();

		// the owner sees it in their studio
		const mine = await makeAPIRequest("/v1/studio/pages", {
			authToken: user.token,
			expectedBodySchema: StudioPagesModel.GetAll.Response,
		});
		expect(mine.find((page) => page.id === partner.id)?.member_role).toBe("owner");
	});

	test("slugs are unique per category", async () => {
		const admin = await seedUserWithSession("admin");
		const shared = slug("same");
		await createPage(admin.token, { category: "official", slug: shared, name: "A" });
		await createPage(admin.token, { category: "official", slug: shared, name: "B" }, 409);
		await createPage(admin.token, { category: "partner", slug: shared, name: "C" });
	});

	test("pages of others are invisible in the studio", async () => {
		const owner = await seedUserWithSession();
		const stranger = await seedUserWithSession();
		const page = await createPage(owner.token, {
			category: "community",
			slug: slug("private"),
			name: "Mine",
		});

		await makeAPIRequest(`/v1/studio/pages/${page.id}`, { authToken: stranger.token }, 404);
		await makeAPIRequest(
			`/v1/studio/pages/${page.id}`,
			{ method: "PUT", authToken: stranger.token, body: { name: "Hacked" } },
			404,
		);
	});

	test("members: owners manage them, managers can't", async () => {
		const admin = await seedUserWithSession("admin");
		const owner = await seedUserWithSession();
		const manager = await seedUserWithSession();
		const newcomer = await seedUserWithSession();

		const page = await createPage(admin.token, {
			category: "partner",
			slug: slug("team"),
			name: "Team",
			owner_user_id: owner.user.id,
		});

		await makeAPIRequest(`/v1/studio/pages/${page.id}/members`, {
			method: "POST",
			authToken: owner.token,
			body: { discord_id: manager.user.discord_id, role: "manager" },
		});

		const members = await makeAPIRequest(`/v1/studio/pages/${page.id}/members`, {
			authToken: manager.token,
		});
		expect(members.map((member: any) => member.role).sort()).toEqual(["manager", "owner"]);

		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/members`,
			{
				method: "POST",
				authToken: manager.token,
				body: { user_id: newcomer.user.id, role: "manager" },
			},
			403,
		);
		await makeAPIRequest(
			`/v1/studio/pages/${page.id}/members`,
			{ method: "POST", authToken: owner.token, body: { user_id: manager.user.id, role: "owner" } },
			409,
		);

		await makeAPIRequest(`/v1/studio/pages/${page.id}/members/${manager.user.id}`, {
			method: "PUT",
			authToken: owner.token,
			body: { role: "owner" },
		});
		await makeAPIRequest(`/v1/studio/pages/${page.id}/members/${manager.user.id}`, {
			method: "DELETE",
			authToken: owner.token,
		});
		await makeAPIRequest(`/v1/studio/pages/${page.id}`, { authToken: manager.token }, 404);

		// partner members can't delete the page
		await makeAPIRequest(
			`/v1/studio/pages/${page.id}`,
			{ method: "DELETE", authToken: owner.token },
			403,
		);
	});
});

describe("Partner self-service (no review)", () => {
	let owner: Session;
	let pageID: number;
	let collectionID: number;
	let capeID: number;

	beforeAll(async () => {
		const admin = await seedUserWithSession("admin");
		owner = await seedUserWithSession();
		const page = await createPage(admin.token, {
			category: "partner",
			slug: slug("selfservice"),
			name: "Self Service Partner",
			owner_user_id: owner.user.id,
		});
		pageID = page.id;
	});

	test("create collection and cape as draft — invisible in the catalog", async () => {
		const collection = await makeAPIRequest(`/v1/studio/pages/${pageID}/collections`, {
			method: "POST",
			authToken: owner.token,
			body: { name: "Summer 2026" },
		});
		collectionID = collection.id;

		const texture = await uploadAsset(
			owner.token,
			"cape_texture",
			createPNG(128, 64, [1, 2, 3, 255]),
		);

		const cape = await makeAPIRequest(`/v1/studio/pages/${pageID}/products`, {
			method: "POST",
			authToken: owner.token,
			body: {
				type: "cape",
				name: "Sunset Cape",
				collection_id: collectionID,
				texture_asset_id: texture.asset.id,
			},
			expectedBodySchema: StudioProductsModel.Create.Response,
		});
		capeID = cape.id;
		expect(cape.status).toBe("draft");
		expect(cape.creator?.id).toBe(owner.user.id);

		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 404);
	});

	test("publishing goes live without review", async () => {
		const published = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}/publish`, {
			method: "POST",
			authToken: owner.token,
			expectedBodySchema: StudioProductsModel.Create.Response,
		});
		expect(published.status).toBe("published");
		expect(published.published_at).not.toBeNull();

		const product = await makeAPIRequest(`/v1/catalog/products/${capeID}`, {
			expectedBodySchema: CatalogModel.GetProduct.Response,
		});
		expect(product.page.id).toBe(pageID);
		expect(product.collection?.id).toBe(collectionID);
		expect(product.texture?.url).toContain("/assets/");

		const collection = await makeAPIRequest(`/v1/catalog/collections/${collectionID}`, {
			expectedBodySchema: CatalogModel.GetCollection.Response,
		});
		expect(collection.products.map((p) => p.id)).toEqual([capeID]);

		const pages = await makeAPIRequest("/v1/catalog/pages?category=partner", {
			expectedBodySchema: CatalogModel.GetPages.Response,
		});
		expect(pages.find((page) => page.id === pageID)?.product_count).toBe(1);
	});

	test("unlisted products are reachable by id but not listed", async () => {
		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: owner.token,
			body: { listed: false },
		});

		const listed = await makeAPIRequest(`/v1/catalog/products?page_id=${pageID}`);
		expect(listed).toEqual([]);
		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 200);

		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: owner.token,
			body: { listed: true },
		});
	});

	test("a cape needs a texture and cosmetics can't take one", async () => {
		const empty = await makeAPIRequest(`/v1/studio/pages/${pageID}/products`, {
			method: "POST",
			authToken: owner.token,
			body: { type: "cape", name: "No Texture" },
		});
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${empty.id}/publish`,
			{ method: "POST", authToken: owner.token },
			400,
		);

		const texture = await uploadAsset(owner.token, "cape_texture", createPNG(64, 32, [9, 9, 9, 255]));
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products`,
			{
				method: "POST",
				authToken: owner.token,
				body: { type: "cosmetic", name: "Wrong", texture_asset_id: texture.asset.id },
			},
			400,
		);
	});

	test("assets must match their use", async () => {
		const image = await uploadAsset(owner.token, "image", createPNG(64, 64, [5, 5, 5, 255]));
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products`,
			{
				method: "POST",
				authToken: owner.token,
				body: { type: "cape", name: "Square", texture_asset_id: image.asset.id },
			},
			400,
		);
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products`,
			{
				method: "POST",
				authToken: owner.token,
				body: { type: "cape", name: "Ghost", texture_asset_id: "f".repeat(64) },
			},
			400,
		);
	});

	test("cosmetic variants per skin model", async () => {
		const hat = await makeAPIRequest(`/v1/studio/pages/${pageID}/products`, {
			method: "POST",
			authToken: owner.token,
			body: { type: "cosmetic", name: "Arm Band" },
		});

		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${hat.id}/publish`,
			{ method: "POST", authToken: owner.token },
			400,
		);

		const model = await uploadAsset(
			owner.token,
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(createModel())),
		);
		const slimModel = await uploadAsset(
			owner.token,
			"cosmetic_model",
			new TextEncoder().encode(JSON.stringify(createModel({ credit: "slim fit" }))),
		);
		const texture = await uploadAsset(
			owner.token,
			"cosmetic_texture",
			createPNG(64, 32, [7, 7, 7, 255]),
		);

		const wide = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${hat.id}/variants`, {
			method: "POST",
			authToken: owner.token,
			body: {
				name: "Classic arms",
				skin_model: "wide",
				model_asset_id: model.asset.id,
				texture_asset_id: texture.asset.id,
			},
		});
		const slim = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${hat.id}/variants`, {
			method: "POST",
			authToken: owner.token,
			body: {
				name: "Slim arms",
				skin_model: "slim",
				model_asset_id: slimModel.asset.id,
				texture_asset_id: texture.asset.id,
			},
		});

		// textures and models can't be swapped
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${hat.id}/variants/${wide.id}`,
			{ method: "PUT", authToken: owner.token, body: { model_asset_id: texture.asset.id } },
			400,
		);

		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${hat.id}/publish`, {
			method: "POST",
			authToken: owner.token,
		});

		const product = await makeAPIRequest(`/v1/catalog/products/${hat.id}`, {
			expectedBodySchema: CatalogModel.GetProduct.Response,
		});
		expect(product.variants.map((v) => v.skin_model)).toEqual(["wide", "slim"]);

		// capes have no variants
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${capeID}/variants`,
			{ authToken: owner.token },
			400,
		);

		// the last variant of a published cosmetic can't be removed
		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${hat.id}/variants/${slim.id}`, {
			method: "DELETE",
			authToken: owner.token,
		});
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${hat.id}/variants/${wide.id}`,
			{ method: "DELETE", authToken: owner.token },
			409,
		);
	});
});

/** Approves a product as the moderator reviewed it (sends its current updated_at). */
async function approveProduct(token: string, productID: number, expectedCode?: number) {
	const entry = await makeAPIRequest(`/v1/moderation/products/${productID}`, { authToken: token });
	return await makeAPIRequest(
		`/v1/moderation/products/${productID}/approve`,
		{ method: "POST", authToken: token, body: { updated_at: entry.product.updated_at } },
		expectedCode,
	);
}

/** Approves a community page profile as the moderator reviewed it. */
async function approvePage(token: string, pageID: number, expectedCode?: number) {
	const page = await makeAPIRequest(`/v1/moderation/pages/${pageID}`, { authToken: token });
	return await makeAPIRequest(
		`/v1/moderation/pages/${pageID}/approve`,
		{ method: "POST", authToken: token, body: { updated_at: page.updated_at } },
		expectedCode,
	);
}

describe("Community uploads (reviewed)", () => {
	let creator: Session;
	let moderator: Session;
	let pageID: number;
	let capeID: number;

	beforeAll(async () => {
		creator = await seedUserWithSession();
		moderator = await seedUserWithSession("moderator");
		const page = await createPage(creator.token, {
			category: "community",
			slug: slug("creator"),
			name: "Creator Corner",
		});
		pageID = page.id;
		expect(page.review_requested_at).not.toBeNull();
	});

	test("community products can't be exclusive", async () => {
		await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products`,
			{
				method: "POST",
				authToken: creator.token,
				body: { type: "cape", name: "Exclusive?", availability: "exclusive" },
			},
			403,
		);
		await makeAPIRequest(`/v1/studio/pages/${pageID}/codes`, { authToken: creator.token }, 403);
	});

	test("product and page profile both need approval before anything is public", async () => {
		const texture = await uploadAsset(
			creator.token,
			"cape_texture",
			createPNG(64, 32, [3, 3, 3, 255]),
		);
		const cape = await makeAPIRequest(`/v1/studio/pages/${pageID}/products`, {
			method: "POST",
			authToken: creator.token,
			body: { type: "cape", name: "Homemade Cape", texture_asset_id: texture.asset.id },
		});
		capeID = cape.id;

		const submitted = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}/publish`, {
			method: "POST",
			authToken: creator.token,
		});
		expect(submitted.status).toBe("pending_review");

		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 404);
		await makeAPIRequest(`/v1/catalog/pages/${pageID}`, {}, 404);

		const queue = await makeAPIRequest("/v1/moderation/products", { authToken: moderator.token });
		expect(queue.some((entry: any) => entry.product.id === capeID)).toBe(true);

		await approveProduct(moderator.token, capeID);

		// still hidden: the page profile itself was never approved
		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 404);

		const pageQueue = await makeAPIRequest("/v1/moderation/pages?needs_review=true", {
			authToken: moderator.token,
		});
		expect(pageQueue.some((page: any) => page.id === pageID)).toBe(true);

		await approvePage(moderator.token, pageID);

		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 200);
		const page = await makeAPIRequest(`/v1/catalog/pages/${pageID}`, {
			expectedBodySchema: CatalogModel.GetPage.Response,
		});
		expect(page.owner?.id).toBe(creator.user.id);
		expect(page.product_count).toBe(1);

		const bySlug = await makeAPIRequest(`/v1/catalog/pages/by-slug/community/${page.slug}`, {
			expectedBodySchema: CatalogModel.GetPageBySlug.Response,
		});
		expect(bySlug.id).toBe(pageID);
	});

	test("profile edits of a reviewed page wait for a moderator", async () => {
		const studioPage = await makeAPIRequest(`/v1/studio/pages/${pageID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { name: "Totally New Name", description: "fresh" },
			expectedBodySchema: StudioPagesModel.Update.Response,
		});
		expect(studioPage.name).toBe("Creator Corner");
		expect(studioPage.pending_changes?.name).toBe("Totally New Name");

		let page = await makeAPIRequest(`/v1/catalog/pages/${pageID}`);
		expect(page.name).toBe("Creator Corner");

		// rejected: the approved values stay
		await makeAPIRequest(`/v1/moderation/pages/${pageID}/reject`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "Name impersonates a partner" },
		});
		const afterReject = await makeAPIRequest(`/v1/studio/pages/${pageID}`, {
			authToken: creator.token,
		});
		expect(afterReject.pending_changes).toBeNull();
		expect(afterReject.review_note).toBe("Name impersonates a partner");

		// approved: the change goes live
		await makeAPIRequest(`/v1/studio/pages/${pageID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { name: "Creator Corner 2" },
		});
		await approvePage(moderator.token, pageID);
		page = await makeAPIRequest(`/v1/catalog/pages/${pageID}`);
		expect(page.name).toBe("Creator Corner 2");
	});

	test("community collections are public only once reviewed", async () => {
		const collection = await makeAPIRequest(`/v1/studio/pages/${pageID}/collections`, {
			method: "POST",
			authToken: creator.token,
			body: { name: "Winter" },
		});
		expect(collection.reviewed_at).toBeNull();

		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { collection_id: collection.id },
		});

		await makeAPIRequest(`/v1/catalog/collections/${collection.id}`, {}, 404);
		const product = await makeAPIRequest(`/v1/catalog/products/${capeID}`);
		expect(product.collection).toBeNull();

		await approvePage(moderator.token, pageID);
		await makeAPIRequest(`/v1/catalog/collections/${collection.id}`, {}, 200);

		// renaming the reviewed collection waits for review again
		const renamed = await makeAPIRequest(`/v1/studio/pages/${pageID}/collections/${collection.id}`, {
			method: "PUT",
			authToken: creator.token,
			body: { name: "Winter Sale" },
		});
		expect(renamed.name).toBe("Winter");
		expect(renamed.pending_changes?.name).toBe("Winter Sale");
	});

	test("approvals fail when the content changed since the moderator looked at it", async () => {
		const page = await makeAPIRequest(`/v1/moderation/pages/${pageID}`, {
			authToken: moderator.token,
		});
		await makeAPIRequest(`/v1/studio/pages/${pageID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { description: "changed while the moderator was looking" },
		});
		await makeAPIRequest(
			`/v1/moderation/pages/${pageID}/approve`,
			{ method: "POST", authToken: moderator.token, body: { updated_at: page.updated_at } },
			409,
		);
		await approvePage(moderator.token, pageID);
	});

	test("moderators can't review their own community content", async () => {
		const ownPage = await createPage(moderator.token, {
			category: "community",
			slug: slug("mod-own"),
			name: "A moderator page",
		});
		const { product } = await seedProduct(ownPage.id, "cape", { status: "pending_review" });

		await approveProduct(moderator.token, product.id, 403);
		await approvePage(moderator.token, ownPage.id, 403);

		const otherModerator = await seedUserWithSession("moderator");
		await approveProduct(otherModerator.token, product.id);
		await approvePage(otherModerator.token, ownPage.id);
	});

	test("changing a published community product sends it back to review", async () => {
		const before = await makeAPIRequest(`/v1/moderation/products/${capeID}`, {
			authToken: moderator.token,
		});
		const updated = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { name: "Homemade Cape v2" },
		});
		expect(updated.status).toBe("pending_review");
		await makeAPIRequest(`/v1/catalog/products/${capeID}`, {}, 404);

		// the version the moderator looked at is outdated now
		await makeAPIRequest(
			`/v1/moderation/products/${capeID}/approve`,
			{
				method: "POST",
				authToken: moderator.token,
				body: { updated_at: before.product.updated_at },
			},
			409,
		);

		await approveProduct(moderator.token, capeID);

		// ordering changes don't need a review
		const reordered = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { sort_order: 5 },
		});
		expect(reordered.status).toBe("published");
	});

	test("rejected products show the reason and can be resubmitted", async () => {
		await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			method: "PUT",
			authToken: creator.token,
			body: { description: "now with a description" },
		});
		await makeAPIRequest(`/v1/moderation/products/${capeID}/reject`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "Please do not use copyrighted logos" },
		});

		const rejected = await makeAPIRequest(`/v1/studio/pages/${pageID}/products/${capeID}`, {
			authToken: creator.token,
			expectedBodySchema: StudioProductsModel.Create.Response,
		});
		expect(rejected.status).toBe("rejected");
		expect(rejected.review_note).toBe("Please do not use copyrighted logos");

		const resubmitted = await makeAPIRequest(
			`/v1/studio/pages/${pageID}/products/${capeID}/publish`,
			{
				method: "POST",
				authToken: creator.token,
			},
		);
		expect(resubmitted.status).toBe("pending_review");
	});

	test("owners can delete their community page", async () => {
		const user = await seedUserWithSession();
		const page = await createPage(user.token, {
			category: "community",
			slug: slug("tmp"),
			name: "Tmp",
		});
		await makeAPIRequest(`/v1/studio/pages/${page.id}`, { method: "DELETE", authToken: user.token });
		await makeAPIRequest(`/v1/studio/pages/${page.id}`, { authToken: user.token }, 404);
	});
});

describe("Catalog", () => {
	test("categories are the three fixed ones", async () => {
		const categories = await makeAPIRequest("/v1/catalog/categories", {
			expectedBodySchema: CatalogModel.GetCategories.Response,
		});
		expect(categories.map((category) => category.id)).toEqual(["official", "partner", "community"]);
	});

	test("empty community pages are not listed", async () => {
		const user = await seedUserWithSession();
		const page = await createPage(user.token, {
			category: "community",
			slug: slug("empty"),
			name: "Nothing here yet",
		});

		const pages = await makeAPIRequest("/v1/catalog/pages?category=community&limit=100");
		expect(pages.some((p: any) => p.id === page.id)).toBe(false);
	});
});
