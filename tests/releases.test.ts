import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ReleaseHandler } from "../src/api/utils/releases";
import { DB } from "../src/db";
import { makeAPIRequest } from "./helpers/api";
import { FakeGitLab, FakeModrinth } from "./helpers/fakes";
import { seedUserWithSession } from "./helpers/seed";

/** Publishes a release through the admin route and waits for the sync it kicked. */
async function publish(body: Record<string, any>, token: string) {
	const created = await makeAPIRequest("/v1/admin/releases", {
		method: "POST",
		authToken: token,
		body,
	});
	await ReleaseHandler.syncPending();
	return created;
}

/** Attaches the jar to the GitLab release, playing the tag pipeline finishing its build. */
function finishBuild(version: string) {
	FakeGitLab.setRelease(`v${version}`, { jarURL: FakeGitLab.jarURL(version) });
}

describe("Releases", () => {
	let admin: Awaited<ReturnType<typeof seedUserWithSession>>;
	let moderator: Awaited<ReturnType<typeof seedUserWithSession>>;
	let user: Awaited<ReturnType<typeof seedUserWithSession>>;

	beforeAll(async () => {
		admin = await seedUserWithSession("admin");
		moderator = await seedUserWithSession("moderator");
		user = await seedUserWithSession("user");
	});

	beforeEach(() => {
		FakeGitLab.reset();
		FakeModrinth.reset();
	});

	test("nothing is public before a release is published", async () => {
		const releases = await makeAPIRequest("/v1/releases", {}, 200);
		expect(releases).toEqual([]);

		await makeAPIRequest("/v1/releases/latest", {}, 404);
		await makeAPIRequest("/v1/releases/2.0.0", {}, 404);
	});

	test("the admin release routes are for admins only", async () => {
		await makeAPIRequest("/v1/admin/releases", {}, 401);
		await makeAPIRequest("/v1/admin/releases", { authToken: user.token }, 403);
		await makeAPIRequest("/v1/admin/releases", { authToken: moderator.token }, 403);
		await makeAPIRequest("/v1/admin/releases", { authToken: admin.token }, 200);
	});

	test("publishing triggers the GitLab release and waits for its build", async () => {
		const changelog = "## Big release\n- New cosmetics";

		const created = await makeAPIRequest("/v1/admin/releases", {
			method: "POST",
			authToken: admin.token,
			body: { mode: "gitlab_new", version: "3.0.0", changelog },
		});
		expect(created.version).toBe("3.0.0");
		expect(created.status).toBe("pending");
		expect(created.channel).toBe("stable");
		expect(created.modrinth_state).toBe("pending"); // auto_modrinth is on by default
		expect(created.created_by?.id).toBe(admin.user.id);

		// the API created the GitLab release, which is what pushes the tag that starts the build
		expect(FakeGitLab.created).toEqual([
			{ tag: "v3.0.0", name: "LeiCraftClient v3.0.0", description: changelog },
		]);

		// not public while the build runs
		expect(await makeAPIRequest("/v1/releases", {}, 200)).toEqual([]);

		// the pipeline finished and attached the jar
		finishBuild("3.0.0");
		await ReleaseHandler.syncPending();

		const releases = await makeAPIRequest("/v1/releases", {}, 200);
		expect(releases).toHaveLength(1);
		expect(releases[0]).toMatchObject({
			version: "3.0.0",
			title: "LeiCraftClient v3.0.0",
			changelog,
			channel: "stable",
			download_url: FakeGitLab.jarURL("3.0.0"),
			page_url: "http://localhost:12332/download#v3.0.0",
			modrinth_url: "https://modrinth.com/version/3.0.0",
		});

		const latest = await makeAPIRequest("/v1/releases/latest", {}, 200);
		expect(latest.version).toBe("3.0.0");
		expect(await makeAPIRequest("/v1/releases/3.0.0", {}, 200)).toMatchObject({
			version: "3.0.0",
		});

		// auto-published to Modrinth, with the Minecraft version of the tag's gradle.properties
		expect(FakeModrinth.published).toHaveLength(1);
		expect(FakeModrinth.published[0]).toMatchObject({
			version_number: "3.0.0",
			version_type: "release",
			version_body: changelog,
			game_versions: ["26.3"],
			filename: "leicraftclient-3.0.0.jar",
		});

		const managed = await makeAPIRequest("/v1/admin/releases/3.0.0", { authToken: admin.token }, 200);
		expect(managed).toMatchObject({
			status: "published",
			modrinth_state: "published",
			download_url: FakeGitLab.jarURL("3.0.0"),
		});
	});

	test("rejects versions that already have a release, here or on GitLab", async () => {
		await publish({ mode: "gitlab_new", version: "3.0.1", changelog: "one" }, admin.token);

		await makeAPIRequest(
			"/v1/admin/releases",
			{
				method: "POST",
				authToken: admin.token,
				body: { mode: "gitlab_new", version: "3.0.1", changelog: "two" },
			},
			409,
		);

		// a release GitLab already has is a conflict too — import it instead of re-triggering it
		FakeGitLab.setRelease("v3.0.2");
		await makeAPIRequest(
			"/v1/admin/releases",
			{
				method: "POST",
				authToken: admin.token,
				body: { mode: "gitlab_new", version: "3.0.2", changelog: "by hand" },
			},
			409,
		);
	});

	test("rejects versions and tags that cannot name a release", async () => {
		await makeAPIRequest(
			"/v1/admin/releases",
			{
				method: "POST",
				authToken: admin.token,
				body: { mode: "gitlab_new", version: "2", changelog: "x" },
			},
			400,
		);
		await makeAPIRequest(
			"/v1/admin/releases",
			{
				method: "POST",
				authToken: admin.token,
				body: { mode: "gitlab_existing", tag: "vnightly" },
			},
			400,
		);
		await makeAPIRequest(
			"/v1/admin/releases",
			{
				method: "POST",
				authToken: admin.token,
				body: { mode: "gitlab_existing", tag: "v9.9.9" }, // nothing to import there
			},
			404,
		);
	});

	test("imports an existing GitLab release with its notes, jar and pre-release channel", async () => {
		FakeGitLab.setRelease("v2.0.0-pre.5", {
			name: "Pre Release v2.0.0-pre.5",
			description: "pre-release notes",
			jarURL: FakeGitLab.jarURL("2.0.0-pre.5"),
		});

		const imported = await publish({ mode: "gitlab_existing", tag: "v2.0.0-pre.5" }, admin.token);
		expect(imported).toMatchObject({
			version: "2.0.0-pre.5",
			title: "Pre Release v2.0.0-pre.5",
			changelog: "pre-release notes",
			channel: "pre-release",
			// the jar was already attached, so the import finished without waiting for a build
			status: "published",
		});

		// the auto-publish ran through the sync the import kicked
		const managed = await makeAPIRequest("/v1/admin/releases/2.0.0-pre.5", {
			authToken: admin.token,
		});
		expect(managed.modrinth_state).toBe("published");

		// pre-releases are published to Modrinth as beta
		expect(FakeModrinth.published[0]).toMatchObject({
			version_number: "2.0.0-pre.5",
			version_type: "beta",
		});
	});

	test("imports an existing GitLab release whose build is still running", async () => {
		FakeGitLab.setRelease("v2.1.0-pre.1", { description: "still building" });

		const imported = await publish({ mode: "gitlab_existing", tag: "v2.1.0-pre.1" }, admin.token);
		expect(imported.status).toBe("pending");

		finishBuild("2.1.0-pre.1");
		await ReleaseHandler.syncPending();
		expect(await makeAPIRequest("/v1/releases/2.1.0-pre.1", {}, 200)).toMatchObject({
			version: "2.1.0-pre.1",
		});
	});

	test("auto_modrinth: false skips Modrinth entirely", async () => {
		const created = await publish(
			{ mode: "gitlab_new", version: "3.3.0", changelog: "no modrinth", auto_modrinth: false },
			admin.token,
		);
		finishBuild("3.3.0");
		await ReleaseHandler.syncPending();

		const managed = await makeAPIRequest("/v1/admin/releases/3.3.0", { authToken: admin.token }, 200);
		expect(managed).toMatchObject({ status: "published", modrinth_state: "skipped" });
		expect(FakeModrinth.published).toHaveLength(0);
		expect(created.modrinth_state).toBe("skipped");
	});

	test("a failed build is visible with its pipeline and can be retried", async () => {
		await publish({ mode: "gitlab_new", version: "3.1.0", changelog: "tries to build" }, admin.token);

		FakeGitLab.setRelease("v3.1.0", {
			pipeline: { status: "failed", web_url: "https://gitlab.test/fabric/pipelines/9" },
		});
		await ReleaseHandler.syncPending();

		const failed = await makeAPIRequest("/v1/admin/releases/3.1.0", { authToken: admin.token }, 200);
		expect(failed).toMatchObject({
			status: "failed",
			error_message: "The build pipeline failed",
			pipeline_url: "https://gitlab.test/fabric/pipelines/9",
		});

		// the pipeline was retried on GitLab and finished this time
		FakeGitLab.setRelease("v3.1.0", {
			jarURL: FakeGitLab.jarURL("3.1.0"),
			pipeline: { status: "success", web_url: "https://gitlab.test/fabric/pipelines/10" },
		});
		await makeAPIRequest(
			"/v1/admin/releases/3.1.0/retry",
			{ method: "POST", authToken: admin.token },
			202,
		);
		await ReleaseHandler.syncPending();

		expect(await makeAPIRequest("/v1/releases/3.1.0", {}, 200)).toMatchObject({
			version: "3.1.0",
		});
	});

	test("a failed Modrinth publish can be retried on its own", async () => {
		FakeModrinth.failNext = "yes";
		await publish({ mode: "gitlab_new", version: "3.2.0", changelog: "modrinth fails" }, admin.token);
		finishBuild("3.2.0");
		await ReleaseHandler.syncPending();

		// the release itself is out — a Modrinth failure never blocks the download
		const after = await makeAPIRequest("/v1/admin/releases/3.2.0", { authToken: admin.token }, 200);
		expect(after).toMatchObject({ status: "published", modrinth_state: "failed" });
		expect(after.modrinth_error).toBe("Simulated Modrinth failure");

		await makeAPIRequest(
			"/v1/admin/releases/3.2.0/retry",
			{ method: "POST", authToken: admin.token },
			202,
		);
		await ReleaseHandler.syncPending();

		const done = await makeAPIRequest("/v1/admin/releases/3.2.0", { authToken: admin.token }, 200);
		expect(done.modrinth_state).toBe("published");
		expect(FakeModrinth.published).toHaveLength(1);
	});

	test("a build that never finishes fails after the timeout", async () => {
		await publish({ mode: "gitlab_new", version: "3.6.0", changelog: "slow build" }, admin.token);

		// backdate the release beyond the build window
		await DB.instance()
			.update(DB.Tables.releases)
			.set({ created_at: Date.now() - ReleaseHandler.BUILD_TIMEOUT_MS - 1000 })
			.where(eq(DB.Tables.releases.version, "3.6.0"));

		await ReleaseHandler.syncPending();
		const timedOut = await makeAPIRequest(
			"/v1/admin/releases/3.6.0",
			{ authToken: admin.token },
			200,
		);
		expect(timedOut).toMatchObject({ status: "failed" });
		expect(timedOut.error_message).toBe("Timed out waiting for the build to attach the jar");
	});

	test("editing updates the website and the GitLab release notes", async () => {
		await publish({ mode: "gitlab_new", version: "3.4.0", changelog: "original" }, admin.token);
		finishBuild("3.4.0");
		await ReleaseHandler.syncPending();

		await makeAPIRequest("/v1/admin/releases/3.4.0", {
			method: "PUT",
			authToken: admin.token,
			body: { title: "LeiCraft Client 3.4.0", changelog: "edited" },
		});

		expect(FakeGitLab.updatedNotes).toEqual([{ tag: "v3.4.0", description: "edited" }]);
		expect(await makeAPIRequest("/v1/releases/3.4.0", {}, 200)).toMatchObject({
			title: "LeiCraft Client 3.4.0",
			changelog: "edited",
		});

		await makeAPIRequest(
			"/v1/admin/releases/9.9.9",
			{ method: "PUT", authToken: admin.token, body: { changelog: "x" } },
			404,
		);
		await makeAPIRequest(
			"/v1/admin/releases/3.4.0",
			{ method: "PUT", authToken: admin.token, body: {} },
			400,
		);
	});

	test("deleting removes the release from the website only", async () => {
		await publish({ mode: "gitlab_new", version: "3.5.0", changelog: "bye" }, admin.token);
		finishBuild("3.5.0");
		await ReleaseHandler.syncPending();

		await makeAPIRequest(
			"/v1/admin/releases/3.5.0",
			{ method: "DELETE", authToken: admin.token },
			200,
		);

		await makeAPIRequest("/v1/releases/3.5.0", {}, 404);
		await makeAPIRequest("/v1/admin/releases/3.5.0", { authToken: admin.token }, 404);
		// the GitLab release still exists (deleting it there is a GitLab-side decision)
		expect(FakeGitLab.created.map((entry) => entry.tag)).toContain("v3.5.0");
	});

	test("lists GitLab releases as import candidates, marking the imported ones", async () => {
		FakeGitLab.setRelease("v4.0.0-pre.1", { description: "pre" });
		FakeGitLab.setRelease("v4.0.0", { description: "stable" });
		await publish({ mode: "gitlab_existing", tag: "v4.0.0" }, admin.token);

		const candidates = await makeAPIRequest("/v1/admin/releases/import-candidates", {
			authToken: admin.token,
		});
		expect(candidates).toHaveLength(2);
		expect(candidates.find((candidate: any) => candidate.version === "4.0.0").imported).toBe(true);
		expect(candidates.find((candidate: any) => candidate.version === "4.0.0-pre.1").imported).toBe(
			false,
		);

		await makeAPIRequest("/v1/admin/releases/import-candidates", { authToken: user.token }, 403);
	});
});
