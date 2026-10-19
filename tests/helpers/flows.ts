import { expect } from "bun:test";
import { API } from "../../src/api";
import type { AssetSettings } from "../../src/api/utils/shared-models/catalogData";
import { AuthModel } from "../../src/api/versions/v1/routes/auth/model";
import { ClientModel } from "../../src/api/versions/v1/routes/client/model";
import { StudioAssetsModel } from "../../src/api/versions/v1/routes/studio/assets/model";
import { makeAPIRequest } from "./api";
import { FakeDiscord, FakeMojang } from "./fakes";
import { randomMinecraftName, randomMinecraftUUID } from "./seed";

/** Runs the whole Discord login (authorize → Discord → callback) and returns the session. */
export async function loginWithDiscord(discordUser: Parameters<typeof FakeDiscord.authorize>[0]) {
	const { state, verifier } = await makeAPIRequest("/v1/auth/discord/authorize", {
		method: "POST",
		body: {},
		expectedBodySchema: AuthModel.DiscordAuthorize.Response,
	});
	const code = FakeDiscord.authorize(discordUser);

	return await makeAPIRequest("/v1/auth/discord/callback", {
		method: "POST",
		body: { code, state, verifier },
		expectedBodySchema: AuthModel.DiscordCallback.Response,
	});
}

/** Runs the mod handshake (challenge → Mojang joinServer → verify) and returns the client session. */
export async function loginWithMinecraft(
	profile: { uuid?: string; name?: string; skinModel?: "wide" | "slim" } = {},
) {
	const uuid = profile.uuid ?? randomMinecraftUUID();
	const name = profile.name ?? randomMinecraftName();

	const challenge = await makeAPIRequest("/v1/client/auth/challenge", {
		method: "POST",
		expectedBodySchema: ClientModel.Challenge.Response,
	});

	FakeMojang.joinServer(challenge.server_id, { uuid, name, skinModel: profile.skinModel });

	const session = await makeAPIRequest("/v1/client/auth/verify", {
		method: "POST",
		body: { challenge_id: challenge.challenge_id, username: name },
		expectedBodySchema: ClientModel.Verify.Response,
	});

	return { ...session, uuid, name };
}

/** POSTs a multipart upload to /v1/studio/assets and returns the raw response. */
export async function uploadAssetRaw(
	token: string,
	kind: AssetSettings.Kind,
	bytes: Uint8Array,
	fileName = kind === "cosmetic_model" ? "model.cfg" : "texture.png",
) {
	const form = new FormData();
	form.append("kind", kind);
	form.append("file", new File([bytes], fileName));

	return await API.getApp().request("/v1/studio/assets", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: form,
	});
}

/** Uploads an asset and expects success. */
export async function uploadAsset(token: string, kind: AssetSettings.Kind, bytes: Uint8Array) {
	const res = await uploadAssetRaw(token, kind, bytes);
	const body = (await res.json()) as any;
	if (res.status !== 201) {
		console.error("Upload failed:", body);
	}
	expect(res.status).toBe(201);
	return StudioAssetsModel.Upload.Response.parse(body.data);
}
