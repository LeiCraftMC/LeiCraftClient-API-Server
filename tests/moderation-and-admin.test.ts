import { beforeAll, describe, expect, test } from "bun:test";
import { AuthHandler } from "../src/api/utils/authHandler";
import { ModerationReportsModel } from "../src/api/versions/v1/routes/moderation/reports/model";
import { ModerationUsersModel } from "../src/api/versions/v1/routes/moderation/users/model";
import { makeAPIRequest } from "./helpers/api";
import {
	seedMinecraftAccount,
	seedPage,
	seedProduct,
	seedUser,
	seedUserWithSession,
} from "./helpers/seed";

type Session = Awaited<ReturnType<typeof seedUserWithSession>>;

let user: Session;
let moderator: Session;
let admin: Session;

beforeAll(async () => {
	user = await seedUserWithSession("user");
	moderator = await seedUserWithSession("moderator");
	admin = await seedUserWithSession("admin");
});

describe("Access", () => {
	test("moderation is for moderators and admins, admin for admins", async () => {
		await makeAPIRequest("/v1/moderation/products", {}, 401);
		await makeAPIRequest("/v1/moderation/products", { authToken: user.token }, 403);
		await makeAPIRequest("/v1/moderation/products", { authToken: moderator.token }, 200);
		await makeAPIRequest("/v1/moderation/products", { authToken: admin.token }, 200);

		await makeAPIRequest("/v1/admin/users", { authToken: moderator.token }, 403);
		await makeAPIRequest("/v1/admin/users", { authToken: admin.token }, 200);
	});
});

describe("Takedowns", () => {
	test("disabling a partner product hides it everywhere until restored", async () => {
		const partnerPage = await seedPage("partner", null);
		const { product } = await seedProduct(partnerPage.id, "cape");
		const wearer = await seedUser();
		const account = await seedMinecraftAccount(wearer.id, { cape_product_id: product.id });

		await makeAPIRequest(`/v1/moderation/products/${product.id}/disable`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "Reported for copyright" },
		});

		await makeAPIRequest(`/v1/catalog/products/${product.id}`, {}, 404);
		const [profile] = await makeAPIRequest("/v1/players/lookup", {
			method: "POST",
			body: { uuids: [account.uuid] },
		});
		expect(profile.cape).toBeNull();

		// page members can't republish it
		const partner = await seedUserWithSession();
		await makeAPIRequest("/v1/studio/pages", {}, 401);
		await makeAPIRequest(`/v1/studio/pages/${partnerPage.id}/members`, {
			method: "POST",
			authToken: admin.token,
			body: { user_id: partner.user.id, role: "owner" },
		});
		await makeAPIRequest(
			`/v1/studio/pages/${partnerPage.id}/products/${product.id}/publish`,
			{ method: "POST", authToken: partner.token },
			403,
		);

		await makeAPIRequest(`/v1/moderation/products/${product.id}/restore`, {
			method: "POST",
			authToken: moderator.token,
		});
		await makeAPIRequest(`/v1/catalog/products/${product.id}`, {}, 200);

		const [restored] = await makeAPIRequest("/v1/players/lookup", {
			method: "POST",
			body: { uuids: [account.uuid] },
		});
		expect(restored.cape?.product_id).toBe(product.id);
	});

	test("approve and reject only apply to the review queue", async () => {
		const page = await seedPage("official", null);
		const { product } = await seedProduct(page.id, "cape");

		await makeAPIRequest(
			`/v1/moderation/products/${product.id}/approve`,
			{ method: "POST", authToken: moderator.token, body: { updated_at: product.updated_at } },
			409,
		);
		await makeAPIRequest(
			`/v1/moderation/products/${product.id}/reject`,
			{ method: "POST", authToken: moderator.token, body: { reason: "x" } },
			409,
		);
		await makeAPIRequest(
			`/v1/moderation/products/${product.id}/restore`,
			{ method: "POST", authToken: moderator.token },
			409,
		);
	});

	test("hidden pages disappear from the catalog with their products", async () => {
		const page = await seedPage("partner", null);
		const { product } = await seedProduct(page.id, "cape");

		await makeAPIRequest(`/v1/moderation/pages/${page.id}/hide`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "Partnership paused" },
		});
		await makeAPIRequest(`/v1/catalog/pages/${page.id}`, {}, 404);
		await makeAPIRequest(`/v1/catalog/products/${product.id}`, {}, 404);

		const hidden = await makeAPIRequest("/v1/moderation/pages?status=hidden", {
			authToken: moderator.token,
		});
		expect(hidden.find((p: any) => p.id === page.id)?.status_note).toBe("Partnership paused");

		await makeAPIRequest(`/v1/moderation/pages/${page.id}/unhide`, {
			method: "POST",
			authToken: moderator.token,
		});
		await makeAPIRequest(`/v1/catalog/products/${product.id}`, {}, 200);
	});
});

describe("Reports", () => {
	test("report → list → resolve", async () => {
		const page = await seedPage("community", null);
		const { product } = await seedProduct(page.id, "cosmetic");

		const report = await makeAPIRequest("/v1/reports", {
			method: "POST",
			authToken: user.token,
			body: {
				target_type: "product",
				target_id: product.id,
				reason: "copyright",
				details: "This is the logo of another server",
			},
		});
		expect(report.status).toBe("open");

		await makeAPIRequest(
			"/v1/reports",
			{
				method: "POST",
				authToken: user.token,
				body: { target_type: "product", target_id: product.id, reason: "spam" },
			},
			409,
		);
		await makeAPIRequest(
			"/v1/reports",
			{
				method: "POST",
				authToken: user.token,
				body: { target_type: "product", target_id: 999_999_999, reason: "spam" },
			},
			404,
		);

		const open = await makeAPIRequest(
			`/v1/moderation/reports?target_type=product&target_id=${product.id}`,
			{ authToken: moderator.token, expectedBodySchema: ModerationReportsModel.GetAll.Response },
		);
		expect(open.map((r) => r.id)).toEqual([report.id]);
		expect(open[0]?.reporter?.id).toBe(user.user.id);

		const closed = await makeAPIRequest(`/v1/moderation/reports/${report.id}/resolve`, {
			method: "POST",
			authToken: moderator.token,
			body: { status: "resolved", note: "Product disabled" },
			expectedBodySchema: ModerationReportsModel.Report,
		});
		expect(closed.status).toBe("resolved");
		expect(closed.resolved_by?.id).toBe(moderator.user.id);

		await makeAPIRequest(
			`/v1/moderation/reports/${report.id}/resolve`,
			{ method: "POST", authToken: moderator.token, body: { status: "dismissed" } },
			409,
		);
	});
});

describe("Bans", () => {
	test("banning revokes sessions; moderators can't ban staff", async () => {
		const target = await seedUserWithSession();
		const account = await seedMinecraftAccount(target.user.id);

		const banned = await makeAPIRequest(`/v1/moderation/users/${target.user.id}/ban`, {
			method: "POST",
			authToken: moderator.token,
			body: { reason: "Hateful cape", duration_days: 7 },
			expectedBodySchema: ModerationUsersModel.Ban.Response,
		});
		expect(banned.banned).toBe(true);
		expect(banned.banned_until).toBeGreaterThan(Date.now());
		expect(await AuthHandler.getAuthContext(target.token)).toBeNil();

		const detail = await makeAPIRequest(`/v1/moderation/users/${target.user.id}`, {
			authToken: moderator.token,
			expectedBodySchema: ModerationUsersModel.Detail.Response,
		});
		expect(detail.minecraft_accounts.map((a) => a.uuid)).toEqual([account.uuid]);

		const search = await makeAPIRequest(
			`/v1/moderation/users?banned=true&search=${encodeURIComponent(account.name)}`,
			{ authToken: moderator.token },
		);
		expect(search.map((u: any) => u.id)).toEqual([target.user.id]);

		await makeAPIRequest(`/v1/moderation/users/${target.user.id}/unban`, {
			method: "POST",
			authToken: moderator.token,
		});

		const otherModerator = await seedUser("moderator");
		await makeAPIRequest(
			`/v1/moderation/users/${otherModerator.id}/ban`,
			{ method: "POST", authToken: moderator.token, body: { reason: "x" } },
			403,
		);
		await makeAPIRequest(
			`/v1/moderation/users/${admin.user.id}/ban`,
			{ method: "POST", authToken: moderator.token, body: { reason: "x" } },
			403,
		);
		await makeAPIRequest(
			`/v1/moderation/users/${moderator.user.id}/ban`,
			{ method: "POST", authToken: moderator.token, body: { reason: "x" } },
			403,
		);

		// admins can ban moderators
		await makeAPIRequest(`/v1/moderation/users/${otherModerator.id}/ban`, {
			method: "POST",
			authToken: admin.token,
			body: { reason: "Abused moderation rights" },
		});
	});
});

describe("Admin", () => {
	test("role changes apply to existing sessions immediately", async () => {
		const target = await seedUserWithSession();

		await makeAPIRequest("/v1/moderation/products", { authToken: target.token }, 403);

		await makeAPIRequest(`/v1/admin/users/${target.user.id}`, {
			method: "PUT",
			authToken: admin.token,
			body: { role: "moderator" },
		});
		await makeAPIRequest("/v1/moderation/products", { authToken: target.token }, 200);

		await makeAPIRequest(
			`/v1/admin/users/${admin.user.id}`,
			{ method: "PUT", authToken: admin.token, body: { role: "user" } },
			403,
		);

		const log = await makeAPIRequest(
			`/v1/admin/audit-logs?action=user.role_change&target_type=user&target_id=${target.user.id}`,
			{ authToken: admin.token },
		);
		expect(log[0]?.details).toEqual({ from: "user", to: "moderator" });
	});

	test("delete user", async () => {
		const target = await seedUserWithSession();
		await makeAPIRequest(`/v1/admin/users/${target.user.id}`, {
			method: "DELETE",
			authToken: admin.token,
		});
		await makeAPIRequest(`/v1/admin/users/${target.user.id}`, { authToken: admin.token }, 404);
		await makeAPIRequest(
			`/v1/admin/users/${admin.user.id}`,
			{ method: "DELETE", authToken: admin.token },
			403,
		);
	});

	test("users list filters by role", async () => {
		const list = await makeAPIRequest("/v1/admin/users?role=moderator&limit=200", {
			authToken: admin.token,
		});
		expect(list.length).toBeGreaterThan(0);
		expect(list.every((u: any) => u.role === "moderator")).toBe(true);
	});
});
