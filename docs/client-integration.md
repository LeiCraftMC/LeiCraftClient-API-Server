# Client integration (Fabric mod)

How the LeiCraft Client mod talks to this API. It replaces the OptiFine-style V1 routes
(`/capes/<name>.png`, `/users/<name>.cfg`); there is no compatibility layer.

Every JSON response is the envelope `{ success, code, message, data }` — read `data` on success,
branch on `code` otherwise. Rate-limited endpoints answer `429` with a `Retry-After` header
(seconds). Exact request/response schemas: `/docs/v1/openapi`.

## 1. Session handshake (once per game start)

The mod proves it owns the Minecraft account the same way a Minecraft server checks a joining
player — through Mojang's session server. The access token never leaves the game.

```
POST /v1/client/auth/challenge
  → { challenge_id, server_id, expires_at }              (valid 2 minutes, single-use)

MinecraftSessionService.joinServer(profileId, accessToken, server_id)   ← authlib, in the game

POST /v1/client/auth/verify  { challenge_id, username }
  → { token, expires_at, account: { uuid, name, skin_url, skin_model, uses_client, linked_at },
      user: { id, display_name, avatar_url } | null }
```

Send `Authorization: Bearer <token>` (`lcc_client_…`, valid 7 days) on every `/v1/client/*`
call. On a `401`, run the handshake again. Offline/cracked accounts can't do the handshake;
they can still look up other players (section 3).

Errors: `400` expired/reused challenge, `401` Mojang did not confirm the join, `500` Mojang
unreachable.

## 2. Linking the Minecraft account (clickable link)

```
GET  /v1/client/link   → { linked, user, pending_code_expires_at }
POST /v1/client/link   → { code, url, expires_at }        (valid 10 minutes; 409 if already linked)
DELETE /v1/client/link → unlink this Minecraft account (clears its loadout)
```

Show `url` (`<website>/link/minecraft?code=…`) as a clickable chat link or a button
(`ConfirmLinkScreen`). The player logs in with Discord on the website and confirms. Poll
`GET /v1/client/link` every few seconds while waiting; `linked: true` means done. A new
`POST /v1/client/link` invalidates the previous link.

## 3. Rendering players (capes and cosmetics)

Batch lookups instead of one request per player per asset:

```
POST /v1/players/lookup  { uuids: [...], names: [...] }    (≤ 100 players per request, public)
  → [ { uuid, name, uses_client,
        cape: { product_id, texture: { id, url } } | null,
        cosmetics: [ { product_id, variant_id, variants: [
            { id, name, skin_model: "any"|"wide"|"slim", model: { id, url }, texture: { id, url }, sort_order } ] } ] } ]
```

- Players without a profile are **omitted**; treat them as "nothing to render".
- Look up by **UUID**. `names` is only a fallback for offline-mode servers (matches the name the
  account last verified with).
- **Variant choice** per cosmetic: `variant_id` if set; otherwise the first variant whose
  `skin_model` equals the wearer's skin model (`slim` / `wide`, from `PlayerSkin.model()`);
  otherwise the first `any` variant; otherwise the first variant.
- **Caching:** asset URLs (`/assets/<sha256>.<png|json>`) are content-addressed and immutable —
  download each `id` once and keep it (memory or disk); a changed texture gets a new id.
  Profiles change when players re-equip: re-fetch them every few minutes (the V1 mod used 600 s).
- Cape textures are 2:1 PNGs (64×32 up to 2048×1024) — use them as the vanilla cape texture.
  Models are OptiFine *PlayerItem* JSON (the format `CpmParser` reads); a model-level `texture`
  key is stripped on upload — always use the variant's `texture`.
- **Tab-list badge:** `uses_client` is true when the account used the LeiCraft Client within the
  last 30 days (refreshed by the handshake and by client-session requests). This replaces the
  "has a cape" heuristic of `LeiCraftUsers`.

Single lookups exist for the website: `GET /v1/players/{uuid}`, `GET /v1/players/by-name/{name}`
(404 when unknown).

## 4. Own loadout (optional in-game wardrobe)

```
GET /v1/client/loadout
PUT /v1/client/loadout  { cape_product_id: number | null,
                          cosmetics: [ { product_id, variant_id?: number | null } ] }   (≤ 10)
```

Needs a linked account. Products must be published; exclusive ones must be owned by the linked
user (`403` otherwise). The browsable shop is the public `/v1/catalog/*`.

## V1 → V2 mapping

| V1 (OptiFine-style) | V2 |
| --- | --- |
| `GET /capes/<name>.png` (302 to PNG) | `POST /v1/players/lookup` → `cape.texture.url` |
| `GET /users/<name>.cfg` → `{ items: [{ model, texture, active }] }` | `POST /v1/players/lookup` → `cosmetics[].variants[]` |
| `GET /assets/items/<id>/model.cfg`, `texture.png` | immutable `/assets/<sha256>.json` / `.png` |
| players identified by name | players identified by UUID (name only as fallback) |
| "LeiCraft user" = has a cape | `uses_client` |
| link via token from the Minecraft server + `/dashboard/auth/?vt=` or `/verify` | `POST /v1/client/link` + website confirmation |
