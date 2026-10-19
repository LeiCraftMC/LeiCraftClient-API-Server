import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AssetStore } from "../src/api/utils/assets";
import { MaintenanceTasks } from "../src/api/utils/maintenance";
import { DB } from "../src/db";
import { seedAsset, seedPage, seedProduct } from "./helpers/seed";

describe("Maintenance", () => {
	test("orphaned assets are deleted after the grace period, referenced ones are kept", async () => {
		const orphan = await seedAsset("image", 201);
		const fresh = await seedAsset("image", 202);

		const page = await seedPage("official", null);
		const { product } = await seedProduct(page.id, "cape");
		const referenced = product.texture_asset_id as string;

		const old = Date.now() - MaintenanceTasks.ORPHAN_ASSET_GRACE_MS - 1000;
		for (const id of [orphan.id, referenced]) {
			await DB.instance()
				.update(DB.Tables.assets)
				.set({ created_at: old })
				.where(eq(DB.Tables.assets.id, id));
		}

		await MaintenanceTasks.cleanupOrphanAssets();

		expect(await AssetStore.get(orphan.id)).toBeUndefined();
		expect(await Bun.file(AssetStore.getFilePath(orphan.id)).exists()).toBe(false);

		expect(await AssetStore.get(fresh.id)).toBeDefined();
		expect(await AssetStore.get(referenced)).toBeDefined();
		expect(await Bun.file(AssetStore.getFilePath(referenced)).exists()).toBe(true);
	});

	test("expired login states, challenges and link codes are cleaned up", async () => {
		await DB.instance()
			.insert(DB.Tables.oauthStates)
			.values({ state_hash: "expired-state", verifier_hash: "x", expires_at: Date.now() - 1 });
		await DB.instance()
			.insert(DB.Tables.clientAuthChallenges)
			.values({ id: "expired-challenge", server_id: "x", expires_at: Date.now() - 1 });

		await MaintenanceTasks.cleanupExpiredRows();

		expect(
			await DB.instance()
				.select()
				.from(DB.Tables.oauthStates)
				.where(eq(DB.Tables.oauthStates.state_hash, "expired-state"))
				.get(),
		).toBeUndefined();
		expect(
			await DB.instance()
				.select()
				.from(DB.Tables.clientAuthChallenges)
				.where(eq(DB.Tables.clientAuthChallenges.id, "expired-challenge"))
				.get(),
		).toBeUndefined();
	});
});
