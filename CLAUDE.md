# CLAUDE.md — Claude Code specifics

Read `AGENTS.md` first. This file adds Claude-Code-specific notes.

## Slash commands

Defined in `.claude/settings.json`:

- `/verify` — typecheck + relevant tests.
- `/typecheck` — `bun run typecheck`.
- `/test` — `bun test` (focused file or full suite).

## MCP servers

This is a backend service, so it ships no MCP config.

## Working here

- Port 12331 is used by `bun run dev` **and** by the test preload (`API.start(12331)`) — stop a
  running dev server before `bun test`.
- After changing `src/db/schema.ts`, run `bun run db:generate` and commit the new migration.
- Git checkouts on Windows: `.gitattributes` forces LF; Biome fails on CRLF files.
