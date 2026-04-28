# npx Packaging — Spec

Goal: enable `npx github:user/mcp-agents-memory` (or eventually `npx mcp-agents-memory`) on any computer with a free cloud Postgres connection string, so the same MCP server runs on machine A and machine B against shared memory.

## Current pain points (from reading src/db.ts, src/setup.ts, package.json)

1. **No `bin` entry, no shebang** — `npx` cannot find an executable.
2. **`.env` location is `process.cwd()/.env`** with `__dirname/../.env` fallback. When invoked via `npx`, cwd is the user's terminal directory — no `.env` there. Fallback path lands inside `node_modules/mcp-agents-memory/.env`, which `npm install --prefix /tmp/...` blows away.
3. **No `DATABASE_URL` support** — only individual `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME`. Cloud providers (Neon, Supabase, Railway, Fly Postgres) all give connection strings.
4. **No SSL** — `Pool` is configured without `ssl`. Neon/Supabase REQUIRE SSL; this would fail on connect.
5. **Setup wizard only runs initial schema** — actual migrations 006-011 are separate scripts. Fresh user wouldn't get any schema past 005.
6. **Hardcoded seed data** — subject keys like `user_hoon`, `project_centragens`, `team_triplealab` get inserted as the seed even on a generic install.
7. **`setup.ts` calls `process.exit(0)`** — fine for the CLI use case, but it makes the function non-reusable if we want to call it from within the running server (first-run auto-launch).
8. **No way to invoke setup without rebuilding** — `npm run setup` runs `tsc && node build/setup.js`. After `npm install`, the build step has already run; user would invoke `mcp-agents-memory setup` as a subcommand.

## Scope for THIS session (one-shot landable, ~3h)

Tier 1 — make it npx-able locally (`npx /path/to/repo`):
- (a) Add `bin` entry: `"mcp-agents-memory": "build/index.js"`
- (b) Add `#!/usr/bin/env node` shebang to `build/index.js` AND `build/setup.js`. Easiest path: tsc emits clean JS, so add the shebang via a tiny postbuild script that prepends it.
- (c) Add `files` array to package.json so `npm pack` includes only what we ship (build/, .env.example, README.md, LICENSE).
- (d) Subcommand routing in `index.js`: if `process.argv[2] === 'setup'`, run setup wizard; otherwise run MCP server. (Avoids needing two separate `bin` entries.)

Tier 2 — DB configuration that survives npx + cloud Postgres:
- (e) Support `DATABASE_URL` (connection string). Precedence: `DATABASE_URL` > legacy individual vars > error.
- (f) Auto-enable SSL when connection string has `sslmode=require` OR when `DB_SSL=true`. Cloud providers default to SSL; users with self-hosted local Postgres can leave it off.
- (g) `.env` search order updated:
    1. Explicit `MEMORY_CONFIG_PATH` env var (escape hatch)
    2. `~/.config/mcp-agents-memory/.env` (XDG)
    3. `process.cwd()/.env` (project-local override)
    4. `__dirname/../.env` (legacy fallback for current dev setup — keep so we don't break the existing dev flow)

Tier 3 — schema setup that's actually complete:
- (h) Setup wizard now ALSO runs all numbered migrations (006-011) after initial schema, in order. Each migration is idempotent (already checks `migration_history`), so re-runs are safe.
- (i) Seed data is skipped unless wizard explicitly opts into "demo seed" — by default insert only generic system subjects (`system_global`, etc.) since those are referenced by code paths.

Tier 4 — first-run UX:
- (j) Server startup checks: if `DATABASE_URL` and individual `DB_*` vars are BOTH unset, log a clear error pointing user to `npx mcp-agents-memory setup`. Don't auto-launch wizard from server (MCP runs over stdio; interactive prompts would corrupt the protocol).

## Out of scope (deferred)

- npm publish — requires picking a final package name + namespace decision. Once the above lands, `npx github:USER/mcp-agents-memory` works for personal cross-machine use without publishing.
- Auto-detection of cloud provider type and provider-specific quickstarts in the wizard.
- Migration rollback / down-migrations — current migrations are forward-only; that stays.
- `pgvector` extension auto-install — Neon enables it on demand via `CREATE EXTENSION` (already in setup.ts), Supabase requires manual toggle. Document, don't automate.
- Removing legacy `DB_HOST`/etc. — keep both modes during transition; `DATABASE_URL` simply takes precedence when present.
- SSH tunneling refactor — already opt-in via `SSH_ENABLED=true`; no change needed.

## Concrete file changes

### Modified
- `package.json` — add `bin`, `files`, `postbuild` script to prepend shebang.
- `src/db.ts` — env loading rewrite (XDG path search), `DATABASE_URL` support, SSL auto-enable.
- `src/index.ts` — subcommand router at top of file (`if (process.argv[2] === 'setup') runSetupWizard()`).
- `src/setup.ts` — wizard prompts updated (offer "connection string" path), runs migrations 006-011 inline, generic seed only (or no seed by default + opt-in flag).
- `.env.example` — add `DATABASE_URL` documented at top, mark legacy vars as alternative.
- `README.md` — 5-minute install section: "Get free Postgres at neon.tech, run `npx github:USER/mcp-agents-memory setup`, paste connection string + OpenAI key, add to Claude Desktop config."

### New
- `scripts/prepend-shebang.mjs` — tiny postbuild step that adds `#!/usr/bin/env node` to build/index.js and build/setup.js.

## Risk surface

1. **Existing dev environment breaks** — current `.env` at project root must keep working. The XDG search ORDER puts `~/.config/...` ahead of `cwd`, so a developer who has a project-root `.env` and an XDG one would see the XDG one win. Mitigation: keep `MEMORY_CONFIG_PATH` env var as escape, document.
2. **Migration ordering** — migrations 006-011 use sequential numbers but exec is currently manual. Need to glob + sort numerically, not lexically (`011` > `006` lexically by accident here, but fragile if we ever hit `010` vs `9`). Sort by leading-number.
3. **Subcommand router collision** — `index.js` is the MCP entrypoint. Adding `argv[2] === 'setup'` is safe because MCP is invoked via stdio with no positional args. Confirm no current launcher passes positional args.
4. **Seed change is observable** — current users who actually rely on `user_hoon` / `project_centragens` seed rows would break. This is just the user himself. Acceptable.

## Verification plan

1. `npm run build` — green tsc.
2. From a fresh empty directory: `node /Users/hoon/Documents/.../build/index.js setup` — wizard runs, .env lands at `~/.config/mcp-agents-memory/.env`, all migrations execute against a NEW database (would need a test DB).
3. From the same fresh directory: `node /Users/hoon/Documents/.../build/index.js` (no args) — server starts in MCP mode, no migration re-runs (idempotent), tool list intact.
4. Set `DATABASE_URL=postgres://...?sslmode=require` and start — SSL enabled, connection works.
5. Existing test suite (`scratch/test_v50_*.js`) still passes — they use the dev `.env`, which the legacy fallback path still serves.

## Open questions for advisor

1. **Wizard config write target** — XDG (`~/.config/mcp-agents-memory/.env`) is the cleanest; project-root .env is the legacy. Should the wizard prompt the user which one to write, or just always write to XDG and document that `MEMORY_CONFIG_PATH` overrides? (Latter is simpler.)
2. **Seed data philosophy** — keep none by default, or insert minimum-viable system subjects (`system_global`, `system_orchestrator`)? The code paths reference these in places (migrations write to `system_global`).
3. **Subcommand routing** — `argv[2] === 'setup'` works but isn't extensible. Worth adding a tiny commander-style switch now (`setup`, `migrate`, `version`) or leave as if/else until needed?
4. **Migration runner location** — embed migration execution into setup wizard, or extract to `src/run_migrations.ts` exposed as its own subcommand (`mcp-agents-memory migrate`)? Latter is cleaner separation but more surface for v1.
5. **Postbuild script vs. inline shebang in source** — TypeScript allows leading `#!/usr/bin/env node` line and tsc preserves it. That's simpler than a postbuild script. Worth confirming.
