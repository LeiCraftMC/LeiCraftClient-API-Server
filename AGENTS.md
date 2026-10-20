# AGENTS.md — operating manual for AI coding agents

You are working in the LeiCraft Client API server, a LeiCraftMC backend service. Follow the
LeiCraftMC Style Guides: https://git.leicraftmc.de/LeiCraftMC/Style-Guides.

## Must read

- [docs/00-overview.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/00-overview.md)
- [docs/04-backend-hono.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/04-backend-hono.md)
- [docs/05-api-contract.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/05-api-contract.md)
- [docs/08-database.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/08-database.md)
- [docs/12-testing.md](https://github.com/LeiCraftMC/Style-Guides/blob/main/docs/12-testing.md)
- This repo: [README.md](README.md) (domain concepts) and
  [docs/client-integration.md](docs/client-integration.md) (the mod's protocol — keep it in sync
  when you change `/v1/client/*` or `/v1/players/*`).

## Non-negotiable

- Every route uses the `{ success, code, message, data }` envelope via `APIResponse.*` helpers
  (errors omit `data`). Exception: raw files at `/assets/<sha256>.<png|json>`.
- Validate with `hono-openapi`'s validator (`import { validator as zValidator } from "hono-openapi"`).
- Auth uses opaque bearer tokens (`lcc_sess_`, `lcc_apikey_`, `lcc_client_` + `<id>:<base>`,
  `Bun.password`-hashed). See docs/10-auth.md.
- Never hand-edit generated files (Drizzle migrations in `drizzle/migrations/`).
- Static classes for services (`API`, `DB`, `Logger`, `ConfigHandler`, `AuthHandler`, …).
- Format with Biome before finishing (`bun run check:ci`).
- Conventional Commits.

## Project rules

- Env prefix `LCC_`, token prefix `lcc_`, port 12331 (website 12332).
- There are no passwords: accounts come from the Discord login; `LCC_ADMIN_DISCORD_IDS` bootstraps
  admins. Do not re-add the template's password login, reset or email modules.
- Enums shared by schema, models and services live in
  `src/api/utils/shared-models/{accountData,catalogData}.ts`; response shapes used by several
  routers in `src/api/utils/shared-models/views.ts` (built by `CatalogViews`).
- Page permissions go through `PagePermissions.can(...)` / `StudioPageContext.deny(...)`.
  Moderators act through `/v1/moderation`, not the studio.
- Anything public must stay filtered on read (`CatalogQueries.publicProduct()` /
  `publicCollection()`, `LoadoutHandler.getProfiles`): published product, active page, reviewed
  profile for community pages, owned if exclusive, user not banned.
- Community page profiles and collections go through `CommunityReview` (pending changes after
  the first approval). Disabled products are frozen: no edits until a moderator restores them.
- Product and variant files go through `AssetStore.checkReferences` **and**
  `AssetStore.checkExclusiveUse` (files of exclusive products stay with their page).
- Record staff and studio actions on shared content with `AuditLog.record(...)`; in the studio
  use `StudioPageContext.shouldAudit(c)` (official/partner pages, admin interventions).
- Sub-router base paths are relative to their parent router (`/:productId/variants` under
  `/:pageId/products`). `tests/api-routes-v1.test.ts` checks every path parameter is declared.
- **Transactions are not atomic on bun-sqlite**: `DB.instance().transaction(async …)` commits
  statement by statement (drizzle's sync driver can't await inside a transaction). Make
  race-sensitive steps a single conditional statement (`UPDATE … WHERE … RETURNING`, see
  `RedeemCodeHandler.redeem` and `MinecraftAccountHandler.link`).
- Tests never touch the network: Discord and Mojang are answered by `tests/helpers/fakes.ts`.
