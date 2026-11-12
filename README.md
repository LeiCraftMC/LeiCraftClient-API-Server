# LeiCraft Client API Server

Backend of **LeiCraft Client V2**: Discord accounts, Minecraft account linking through the mod,
the cape & cosmetics shop (official, partner and community pages), exclusive items via redeem
codes and grants, and moderation.

It replaces the V1 PHP/Node APIs (`capesapi.leicraftmc.de`, OptiFine-compatible routes). The new
API is **not** OptiFine-compatible: the Fabric mod talks to `/v1/client/*` and `/v1/players/*`
instead — see [docs/client-integration.md](docs/client-integration.md).

Built from the LeiCraftMC Style Guides `backend-service` template
([git.leicraftmc.de/LeiCraftMC/Style-Guides](https://git.leicraftmc.de/LeiCraftMC/Style-Guides)).

## Stack

- Bun runtime + package manager + test runner
- Hono + Zod + `hono-openapi` + Scalar (`/docs/v1`)
- Drizzle ORM + `bun-sqlite`
- Biome formatter/linter
- AGPL-3.0

## Setup

```bash
bun install
cp example.env .env
# fill in LCC_DISCORD_CLIENT_ID / LCC_DISCORD_CLIENT_SECRET and your Discord user id in
# LCC_ADMIN_DISCORD_IDS, then:
bun run dev        # http://localhost:12331 → API docs at /docs/v1
```

Ports: the API runs on **12331**, the website on **12332** (`LCC_APP_URL`).

**Discord app:** use the existing LeiCraft Client application and add the redirect URI
`<LCC_APP_URL>/auth/discord/callback` (or set `LCC_DISCORD_REDIRECT_URI`). For the automatic
join of the LeiCraftMC Discord server (as in V1) set `LCC_DISCORD_GUILD_ID` and
`LCC_DISCORD_BOT_TOKEN`; the bot must be in the server.

**First admin:** there are no passwords — put your Discord user id into `LCC_ADMIN_DISCORD_IDS`
and log in once through the website. Admins can then promote others (`PUT /v1/admin/users/{id}`).

**Mod releases (optional):** publishing from the admin dashboard needs a GitLab token with
fine-grained scopes (`LCC_GITLAB_TOKEN`, see `example.env`); the Modrinth auto-publish needs a
project token (`LCC_MODRINTH_TOKEN`). Without them the public release endpoints still work, and
publishing answers with a clear 503.

## Scripts

- `bun run dev` — watch mode
- `bun run check` / `bun run format` — Biome check / format
- `bun run typecheck` — TypeScript check
- `bun test` — run tests (in-memory fakes for Discord, Mojang, GitLab and Modrinth, no network)
- `bun run db:generate` — generate migrations after changing `src/db/schema.ts`
- `bun run db:migrate` — run migrations
- `bun run compile linux-x64-baseline` — single binary in `build/bin/` (migrations embedded; see `docker/`)
- `bun run start` — run via `scripts/entrypoint.ts` (auto-migrates the DB)

## Concepts

### Accounts and tokens

| Token | Prefix | Who | How |
| --- | --- | --- | --- |
| Session | `lcc_sess_` | website user | Discord OAuth2 login (`/v1/auth/discord/*`), 7 days |
| API key | `lcc_apikey_` | user's scripts, e.g. a partner bot granting items | `/v1/account/apikeys` |
| Client session | `lcc_client_` | the Fabric mod, bound to one Minecraft account | Mojang session handshake (`/v1/client/auth/*`), 7 days |

The **Discord login** works like V1 (authorization code grant, scopes `identify guilds.join`,
user is added to the LeiCraftMC server) plus a single-use `state` and a browser-bound `verifier`
against login CSRF. The website owns the redirect page:

1. `POST /v1/auth/discord/authorize` → keep `verifier` in the browser (e.g. `sessionStorage`,
   never in a URL) and send the browser to `authorize_url`.
2. Discord redirects to `<APP_URL>/auth/discord/callback?code&state`.
3. The website calls `POST /v1/auth/discord/callback` with `code`, `state` and the stored
   `verifier`, stores the returned token and navigates to `redirect_path`.

Global roles: `admin`, `moderator`, `user`.

### Minecraft accounts and linking

The mod proves account ownership like a Minecraft server does: it calls Mojang's `joinServer`
with a server id from `POST /v1/client/auth/challenge`, and the API asks Mojang's session server
(`hasJoined`) in `POST /v1/client/auth/verify`. The Minecraft access token never leaves the game.

Linking: the mod calls `POST /v1/client/link` and shows the returned `url`
(`<APP_URL>/link/minecraft?code=…`, valid 10 minutes) as a clickable link. The website shows the
account (`GET /v1/account/minecraft/link/{code}`) and the logged-in user confirms
(`POST /v1/account/minecraft/link`). A user can link up to 5 Minecraft accounts; **each linked
account has its own loadout** (cape + up to 10 cosmetics).

### Catalog: categories → pages → collections → products

- **Categories** are fixed: `official` (a single page — the LeiCraft Client team's shop; the
  database allows only one), `partner` (one page per partner), `community` (one page per user).
- **Pages** have members (`owner`, `manager`) who manage them in the **studio** (`/v1/studio/*`).
  Users create their own community page; admins create the official page and partner pages and
  assign owners. Partners are self-service.
- **Collections** group products on a page (called *packages* in V1).
- **Products** are capes (one 2:1 PNG texture) or cosmetics (OptiFine *PlayerItem* models as
  exported by Blockbench). Cosmetics have **variants** — model + texture per skin model
  (`any`, `wide`, `slim`); renderers pick the variant that fits the wearer.
- Status: `draft` → `published`. On community pages publishing means `pending_review` until a
  moderator approves; any content change sends a live community product back to review.
  Moderators can `disable` any product (its content is frozen until `restore` returns it to its
  previous status) and hide any page.
- **Community page profiles are reviewed too:** a community page (name, slug, description, icon,
  banner) and its collections are public only after a moderator approved the profile once
  (`POST /v1/moderation/pages/{id}/approve`). Later edits wait in `pending_changes`; the shop keeps
  the approved values until the next approval. Approvals carry the `updated_at` the moderator
  reviewed (409 if it changed since), and moderators can't review their own pages.
- Availability: `free` (anyone can equip) or `exclusive` (official/partner only — owned through a
  **redeem code** or a **direct grant** from the page). `listed: false` hides a product from the
  catalog listings (reachable by id).
- **Wardrobe:** each user's own collection (`/v1/account/wardrobe`, the mod's `/v1/client/wardrobe`)
  — the exclusives they own (always there) plus free products they saved from the shop
  (`PUT /v1/account/wardrobe/{productId}`, at most 500). Equipping a free product saves it too;
  removing one (`DELETE …/{productId}`) also takes it off every linked account.

### Assets

Uploads (`POST /v1/studio/assets`, multipart, page members only) are validated per kind (cape
texture, cosmetic texture, cosmetic model, image) and stored content-addressed: the id is the
SHA-256, the file is served at `/assets/<id>.<png|json>` with `Cache-Control: immutable` and
`Access-Control-Allow-Origin: *`. Models are re-serialized with known keys only. Files of an
exclusive product can't be used by another page. Unreferenced uploads are deleted after 24 hours.

### Mod releases

Releases of the Fabric mod are published from the admin dashboard (`/v1/admin/releases`, admins
only) in two ways:

1. **Trigger a new GitLab release** (default): the API creates the release on the mod's GitLab
   project (`LCC_GITLAB_*`), which pushes the `v<version>` tag and starts the tag pipeline that
   builds the jar, uploads it to the project's generic package registry and attaches it to the
   release. A per-minute sync publishes the release here once that jar asset link appears, and
   fails it visibly when the pipeline fails.
2. **Import an existing GitLab release**: its notes become the changelog (editable) and its jar
   asset becomes the download — done immediately when the build already finished.

The changelog is markdown and is also written to the GitLab release notes. With **auto-publish to
Modrinth** (on by default, `LCC_MODRINTH_*`) the finished jar is uploaded to the configured
Modrinth project, with the Minecraft versions read from the tag's own `gradle.properties` — a
Modrinth failure never blocks the download and can be retried. Deleting a release removes it from
the website only; the GitLab release, tag and jar stay.

Public endpoints (`/v1/releases`) serve finished releases: changelog, the direct jar download
(package registry permalink) and the Modrinth page. The website's download page and the mod's
update check consume them (see `docs/client-integration.md`).

### Moderation & administration

`/v1/moderation/*` (moderators + admins): review queues for products and community page
profiles, reject / disable / restore products, hide pages, reports from users
(`POST /v1/reports`), bans (moderators can't ban or unban staff).
`/v1/admin/*` (admins): user roles and deletion, audit log of all staff and studio actions on
shared content.

## Endpoint map

| Area | Base path | Auth |
| --- | --- | --- |
| Discord login, session | `/v1/auth` | public / session |
| Account, API keys, preferences | `/v1/account` | session |
| Linked Minecraft accounts, loadouts | `/v1/account/minecraft` | session |
| Wardrobe (saved items) | `/v1/account/wardrobe` | session |
| Inventory, redeem codes | `/v1/account/inventory` | session |
| Mod: handshake, link, own loadout | `/v1/client` | public / client session |
| Player profiles (cape + cosmetics), landing-page showcase | `/v1/players` | public |
| Mod releases, changelog, downloads | `/v1/releases` | public |
| Shop | `/v1/catalog` | public |
| Reports | `/v1/reports` | session |
| Studio: pages, members, collections, products, variants, owners, codes, assets | `/v1/studio` | session or API key |
| Moderation | `/v1/moderation` | moderator / admin |
| Administration, mod releases | `/v1/admin` | admin |
| Files | `/assets/<sha256>.<png\|json>` | public |

The full contract is the OpenAPI spec at `/docs/v1/openapi` (Scalar UI at `/docs/v1`).

## Structure

See the LeiCraftMC style guide:

- [docs/04-backend-hono.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/04-backend-hono.md)
- [docs/05-api-contract.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/05-api-contract.md)
- [docs/08-database.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/08-database.md)

Project-specific services live in `src/api/utils/` (`discord.ts`, `mojang.ts`, `gitlab.ts`,
`modrinth.ts`, `releases.ts`, `assets.ts`, `loadouts.ts`, `minecraftAccounts.ts`, `inventory.ts`,
`redeemCodes.ts`, `products.ts`, `permissions.ts`, `users.ts`, `auditLog.ts`); shared enums in
`src/api/utils/shared-models/catalogData.ts`, shared response shapes in
`src/api/utils/shared-models/views.ts`.

## License

AGPL-3.0
