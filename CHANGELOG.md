# Changelog

## 0.9.25 — 2026-10-04

### The d_tag promoter suggests new project tags instead of creating them

Every 10 minutes the d_tag promoter turned frequent d_tags into project tags on
its own. Of the 130 tags it created between 08-01 and 10-03, 66 were names the
clusterer made up (`bug-fix-code-review`, `oauth-workflow`, …) that matched no
d_tag and so tagged 0 memories, and most of the rest were generic words (`bug`,
`fix`, `save`, `upload`, `windows`). Deleting one did not help: `mcp` was
created again a minute after it was deleted.

- A frequent d_tag that is not a project tag yet no longer becomes one. It is
  stored as a suggestion (`project_tag_new_suggestions`, migration 030) with a
  recommendation from the same model: `project`, `generic` or `unsure`. The
  model is told never to call a proper name `generic`. On 70 real tag names
  (local Qwen3-14B) it rated all five known projects `project`, product and
  service names (`cafe24`, `smartstore`, `buzz`) `unsure`, and no real project
  `generic`.
- Nothing is tagged until a person confirms. Confirming creates the project tag
  and tags the untagged memories that carry that exact d_tag.
- The promoter tags memories only by the d_tag with the same name as the
  project tag, both after a confirm and for tags that already exist. Until
  0.9.24 it also tagged memories carrying any d_tag the clusterer had grouped
  with it, and those groups were often wrong. Cluster members now only add up the
  usage count.
- A cluster's name must be one of the input d_tags; made-up names are dropped
  and their members counted on their own. A d_tag that already is a project tag
  stays its own cluster and is never folded into another one. Each d_tag is
  counted in one cluster only.
- A rejected name is never suggested again, by name. It is left out of
  clustering entirely, so rejecting `cafe24-api` does not hide `cafe24` when
  the clusterer groups them, and the promoter never tags memories with a
  rejected name even if that tag exists. The tagger also stops creating a
  rejected name through `NEW:<name>`; the memory gets no project tag instead.
  Names that were confirmed, or that became tags some other way while pending
  (`superseded`), are not suggested again either.
- When the clusterer call fails, that run makes no new suggestions (it still
  tags memories for existing tags). A suggestion stored without a
  recommendation is classified again on a later run.
- The classifier asks for JSON in the prompt and sends `responseFormat: 'json'`,
  so it also works with the default xAI clusterer, not only with a local model.
- `manage_project_tags` gains `list_new_tags`, `confirm_new_tag`,
  `reject_new_tag` and `apply_recommendations`. The last one takes the
  suggestion ids the user was shown and confirms `project`, rejects `generic`,
  and leaves `unsure` or unrated ones pending. Suggestions created after the
  user looked are not touched. If one id fails, the others still go through and
  the result lists the failed ids.
- The startup brief lists up to two pending suggestions that are not rated
  `generic` (`project` first) under "Project Tag Suggestions". If migration 030
  has not run yet, the brief leaves them out instead of failing.
- The run log line is now `suggested / refreshed / blocked / superseded /
  retrotagged`.
- `npm run check:dtag` tests the rules (`src/cold_path/dtag_suggest_gate.ts`).

Run `mcp-agents-memory migrate` before starting this version. Until then the
promoter run fails each time (logged, non-blocking) and the tagger guard is
skipped.

## 0.9.24 — 2026-10-03

### A project-tag alias the user rejected is not proposed again

The alias promoter judges only the top candidate pairs each run (default 12). A
pair the user rejected kept its score, so it came back as a new pending
suggestion (#332 rejected, the same pair returned 3 days later as #407) and
took a slot from new candidates every run.

- A direction (source → target) the user rejected (`decided_by = 'user'`) is
  never proposed again. There is no expiry; to change the decision, set the
  alias by hand (`manage_project_tags set_alias`), which does not go through
  this rule.
- The pair gets one more judgment after the rejection, and only a
  reverse-direction result can reach pending (a reversed proposal was the right
  fix once: pacefy → pacefy-e2503 rejected, then pacefy-e2503 → pacefy
  confirmed). Once a row exists for the pair after the latest rejection, or both
  directions were rejected by the user, the pair is dropped before candidates
  are ranked, so it no longer takes one of the slots.
- When the judge repeats a rejected direction, nothing goes to the pending queue;
  a closed row (`rejected` by `system`, `signals.repeat_of_suggestion_id`)
  records that the chance was used. This check reads the table again just before
  writing, so a rejection made while the run was judging also counts.
- Each run first closes pending suggestions that repeat a user-rejected
  direction (for example ones an older server created before this release),
  except rows the user is creating with `set_alias`.
- Rejections are compared on canonical tag ids: a rejection carries over to the
  tags each side is later merged into (after `youtube` was aliased into
  `youtube-channel-analyzer`, the rejected `youtube → librarian-project` also
  blocks `youtube-channel-analyzer → librarian-project`).
- The alias guards (self-alias, cycle) now record their rejection as
  `decided_by = 'system'` even when a user called `confirm_alias`/`set_alias`,
  so a guard rejection is not mistaken for the user's decision. System
  rejections do not block.
- "Re-propose when there is new evidence" was considered and dropped: the
  explicit-statement detection (keyword + tag-name substring) is loose enough
  that talking about the tags counts as evidence (8 rejected pairs would have
  reopened within 30 days, even counting only the owner's own words).
- The run log line adds `blockedBeforeJudge`, `blockedAfterJudge` and `swept`.
- `npm run check:alias` tests the rule (`src/cold_path/alias_reject_gate.ts`).

## 0.9.23 — 2026-10-02

### Why a Buzz envelope stays uncleaned, by reason (Buzz only)

`envelopesStuck` mixed envelopes that must stay as they are with envelopes the
parser could not read, so a stuck count of 25 said nothing about whether
anything needed fixing.

- The run report adds `envelopesStuckBy` (one reason per envelope; the sum is
  `envelopesStuck`, which is unchanged so existing watchers keep working):
  - `shape` — the cleaner, the quote reader, the room or a quote time could not
    be read, or a quote whose text differs carries a line starting with the next
    entry number (`[k] `), i.e. a later header the reader may have missed. A
    rise here means the Buzz format changed and the code needs a fix.
  - `noRow` — a quoted message has no `buzz:` row in the same room and second,
    e.g. a DM the CLI identity is not a member of. The envelope is the only copy,
    so it stays.
  - `textDiffers` — every quoted message has a row there, but some text differs,
    usually because the message was edited after it was quoted. It stays, as
    0.9.21 documented.
- `buzzQuotedMessages()` also reads a quote header without a display name,
  `[n] <pubkey> (<time>): text` (seen twice from Hermes), alone or mixed with
  named headers. It is tried before the named form, so a header-like phrase in
  the quoted text cannot supply the pubkey or time. A malformed first header
  still returns null; a malformed later one stays as text of the previous quote
  (and is counted under `shape` above).

On the production memory this turns 25 stuck into 2 cleanable + 23 stuck
(`shape` 2 / `noRow` 9 / `textDiffers` 12). The 2 left under `shape` are
envelopes whose quoted message itself discusses envelope tags, which the
cleaner's boundary guard refuses on purpose.

## 0.9.22 — 2026-10-02

### Self-heal Buzz envelopes stored by an older server (Buzz only)

Every MCP server on a machine watches the shared transcript roots (Grok,
Antigravity, Codex, Gemini, …) and the first one to see a line stores it
(deduplicated by `external_uuid`). After an upgrade, a long-lived session can
keep an older server running, so it sometimes wins the race and stores a
`<base>` Buzz envelope uncleaned and without a venue.

- `buzz-ingest` now repairs those rows first (before the base-less step, from
  the same per-run budget): a `user` row of the memory owner that still starts
  with `<base>` (leading whitespace allowed) and has no `raw_message` is cleaned
  with the same rule as capture time (`cleanBuzzEnvelope` default), the
  original goes to `raw_message`, an empty `venue` is filled the way capture
  would have (`buzzTurnVenue`), and the row is re-tagged and re-embedded.
- An envelope the cleaner rejects (an unknown shape, i.e. Buzz changed) is left
  as it is, so a watcher that looks for uncleaned `<base>` rows now only hears
  about real format changes.
- Both envelope steps fill an empty `venue` and clear the project tag and
  d_tags computed from the old text when they rewrite a row (as
  `manage_knowledge update` does).
- The run report adds `healed`, `healedByDevice` (a non-zero count means a
  pre-upgrade memory server is still running on that device — restart it),
  `healReady` (deferred by budget or a row lock) and `healRejected` (rows the
  cleaner refuses: the format-change signal). `--no-reclean` turns off both
  envelope steps.

## 0.9.21 — 2026-10-01

### Base-less Buzz envelopes cleaned once their quotes exist as rows (Buzz only)

Some Buzz ACP adapters send the Buzz manual through the system role, so the
captured turn starts at `<context>` and carries the quoted thread window
(`<thread-context>` / `<conversation-context>`) but no `<base>`. That window was
left alone because it could be the only searchable copy of an agent's Buzz
replies. Since 0.9.20 those messages are rows of their own.

- `cleanBuzzEnvelope(message, { baseless: true })` also accepts an envelope that
  starts at `<context>`, when the context carries the Buzz markers
  (`Scope: thread|channel|dm` and a `Channel: … (#<uuid>)` line). The hot path
  still calls it without the option, so nothing changes at capture time.
- New `buzzQuotedMessages()` reads the entries of the history block the cleaner
  would drop (`[n] name (pubkey) (time): text`, multi-line text kept); unknown
  shapes return null.
- `buzz-ingest` gains a final, database-only step: a base-less envelope of the
  same memory owner is cleaned (`message` = context + turn, `raw_message` = the
  original, re-tagged and re-embedded) only when every quoted message exists as
  a `buzz:` row of the same room (`venue`), the same second and the same text.
  It uses the budget left after new messages (`--max`) and skips a row the
  cold-path worker is holding (2 s lock timeout, retried next run). Envelopes
  that quote a message as it was before a later edit, or quote rooms the CLI
  identity cannot see, stay as they are. `--no-reclean` turns the step off.
- Buzz's latest state wins: a quote whose row was later hidden (deleted in
  Buzz) or edited still counts as covered, so its old wording remains only in
  the envelope's `raw_message`.
- The run report adds `recleaned`, `envelopesReady` (cleanable, deferred by the
  budget) and `envelopesStuck` (Buzz turns with a history window this step
  cannot clean).

## 0.9.20 — 2026-10-01

### Buzz messages as their own rows (`buzz-ingest`, Buzz only)

A Buzz room reached memory only through the envelope an agent received (the
quoted thread window), and an agent's own Buzz replies are sent by a tool call,
so its capture never holds their text. The quoted window was the only searchable
copy of those replies.

- New subcommand `mcp-agents-memory buzz-ingest [--dry-run] [--max N]`
  (`src/auto_save/buzz_ingest.ts`, Buzz only): copies Buzz chat messages into
  memory, one row per message, through the official `buzz` CLI (`channels list`,
  `messages get`, `users get`). It never reads Buzz's database, so Buzz's own
  access rules decide the scope: only rooms the CLI identity is a member of
  (`channels list --member`).
- Row shape: `external_uuid = buzz:<event id>` (re-runs never duplicate),
  `agent_platform = buzz`, `role = user` for the memory owner's pubkeys in
  `BUZZ_INGEST_OWNER` and `assistant` for everyone else (the librarian builds the
  owner's profile from `user` rows), `created_at` = the message time,
  `venue = buzz:<channel>` or `buzz:dm`, `message = "[display name] text"`,
  `raw_message` = the text exactly as in Buzz.
- No state file: each room is read newest-first until a page contains a message
  memory already has, plus 48 hours further back (a message posted late by a
  device with a slow clock is still picked up). New messages are stored
  oldest-first, at most `--max` (default 20) per run, so a first run over a long
  history trickles in without holding up the cold-path queue, and the next run
  continues where it stopped. If paging misbehaves (an empty follow-up page, a
  page that does not move back), the run stops instead of leaving a gap.
- Edits (kind 40003): the latest edit replaces the text (author label kept) and
  the row is re-tagged and re-embedded. Deletions (kind 5 / 9005): the row is
  hidden (`is_active = false`), never deleted; pinned rows are left alone.
- Author labels use `display_name`, else `name`, else the first 8 hex of the
  pubkey. Every profile lookup also asks for the CLI identity's own profile and
  stops if it is missing, since the CLI prints a bad response as an empty list
  (so the CLI identity needs a profile).
- Every CLI call happens before the first write: if the output does not have the
  expected shape, the run writes nothing and exits non-zero, so a watcher can
  tell that Buzz changed. `--dry-run` also reports messages of kinds this
  version does not copy yet (40002, 40008, 45001, 45003) as `unsupported`.
- The `buzz` child process gets only `PATH`, `HOME`, locale/proxy/TLS variables
  and `BUZZ_*` — not database credentials or API keys.
- Known limits: an author with no profile at copy time (or a message signed by
  the relay key, e.g. workflows) keeps the 8-hex label; an edit that is later
  deleted is not reverted; if one room keeps paging abnormally, every room waits
  (a stop is preferred to a gap); each run reads the last 48 hours of every room,
  so a room with thousands of messages a day needs a longer interval.
- `insertRawMemory` accepts an optional `created_at` and `raw_message`.
- Nothing runs unless you call the subcommand (e.g. from a timer).

## 0.9.19 — 2026-10-01

### Where a conversation happened (`venue`)

`agent_platform` says which program ran a turn; it cannot tell a Buzz group
channel from a 1:1 terminal session on the same machine at the same time. Recalled
memories could not show whether something was said in a shared room or privately.

- New nullable column `memory.venue` (migration `029_venue`, metadata-only, same
  lock-timeout retry as 028): `terminal` · `buzz:<channel>` · `buzz:dm` · `buzz`
  (Buzz, channel unreadable) · `slack` · `auto` · `subagent` · NULL (unknown).
- Claude Code capture: a session's venue comes from its first user turn — a Buzz
  envelope → Buzz, `entrypoint: cli` → `terminal`, a Slack marker → `slack`,
  otherwise `auto`. Buzz rows carry the channel of their turn; a reply takes the
  channel of the turn before it (after a restart, the last turn is found by
  reading the transcript backwards from the end).
- Hermes capture: `sessions.source` — `acp` → the Buzz channel of the turn
  (replies follow the preceding turn, seeded from `state.db` after a restart),
  `slack`, `cli` → `terminal`, `subagent`. An `acp` session that never showed a
  Buzz envelope stays NULL.
- Other platforms: user turns that are Buzz envelopes get their channel from the
  `<context>` block; other rows stay NULL for now.
- `search_memory`: every result carries `venue`, and a new optional `venue`
  filter narrows by prefix (`buzz`) or exactly (`buzz:DevRoom`).
- `memory_startup` brief: each line shows the venue, and a Buzz turn shows the
  person's words on one line instead of its `<context>` block.
- Databases without the column keep working: capture stores rows without venue
  (one warning; migrate and restart), and search/brief skip venue.
- Existing rows are not changed by this release.
- `npm run check:envelope` now bundles the self-check with esbuild.

## 0.9.18 — 2026-09-30

### Embedding input for cleaned Buzz turns

After 0.9.17, a cleaned Buzz turn still starts with the channel `<context>`
block and each event carries header lines (event id, kind, time, npub/hex). That
text is identical across rows, so it pulled Buzz rows toward each other and away
from the queries that concern them.

- New `buzzEmbeddingText()` (`src/auto_save/buzz_envelope.ts`): when a message
  has the shape of a Buzz turn (`<context>` immediately followed by a turn block,
  as 0.9.17 stores cleaned envelopes), the embedding is computed on the turn
  without `<context>`, without the event header lines (event id, kind, time,
  Nostr tag lines) and with `From:`/`Channel:` reduced to names. Anything else is
  embedded as before.
- Only the embedding input changes. The stored `message` (what tagging and
  search results show) is untouched, and `<context>` still reaches the tagger,
  where its project slug helps.
- Checked on a blind-graded retrieval test (10 queries, top 10): exact hits went
  from 29 to 33, related hits from 59 to 63, and nDCG@10 from 0.761 to 0.813.
  No query got worse.
- Existing rows keep their current embedding until they are re-embedded.

## 0.9.17 — 2026-09-30

### Buzz envelope cleanup at capture time (+ raw original kept)

Some Buzz ACP adapters (observed: Hermes, Grok CLI, OpenCode, Antigravity CLI)
hand each turn to the agent as one user message wrapped in a large envelope —
a ~17k-char platform manual, agent settings, and a re-quote of the earlier
thread — with the actual new message at the very end. Captured as-is, this
pushed the cold-path tagger past the local model's context (falling back to the
remote model) and made the embedding (first 8,000 chars) see only the manual, so
envelope rows were near-identical vectors (avg cosine 0.985 vs 0.36 for normal
rows).

- New `cleanBuzzEnvelope()` (`src/auto_save/buzz_envelope.ts`): for a `user`
  message that starts with `<base>…</base>`, reads the envelope in order —
  `<agent-instructions>` / `<core-memory>`, then `<context>`, then an optional
  history block (`<thread-context>` / `<conversation-context>`) directly after
  it, then the turn blocks (`<buzz-event(s)>`, `<what-you-were-working-on>`,
  `<new-message-arrived-while-you-were-working>`). It drops the manual, the
  settings blocks and the history, keeps `<context>` verbatim and the whole turn
  from its first block to the end. Nostr `Tags:`/`Parsed:` lines (with 64-hex
  ids) are dropped. Blocks joined by a single space (Grok CLI) are handled. Any
  unexpected block, an ambiguous history boundary, or a turn block showing up
  inside a part that would be dropped returns `null` and the message is stored
  unchanged. When the history quotes its own closing tag, the result is `null` or
  keeps a little extra history — never less of the turn.
- `insertRawMemory` stores the cleaned text in `message` (what search, tagging
  and embedding read) and the untouched original in the new `raw_message`
  column. Pinned (`is_pinned`) rows, `assistant` rows, and rows saved with a
  precomputed tag or embedding are never rewritten.
- Migration `028_raw_message`: nullable `memory.raw_message TEXT` (no rewrite
  of existing rows). It takes the table lock with `lock_timeout = 5s` and
  retries, so a running cold-path batch cannot make captures queue behind it
  for long. If the column is missing (migration not yet run), capture keeps
  working and stores envelopes unchanged, with a warning; restart the process
  after migrating.
- Checked read-only against 188 real envelope rows: all recognized; in every
  row the turn from its first block to the end is kept byte-identical and the
  cut falls right after the history/context close; 0 false positives on 8,000
  other rows; ~88% fewer characters. Self-check (synthetic, incl. quoted-tag and
  pathological inputs): `node scripts/check_buzz_envelope.ts`.
- Existing rows are not changed by this release.

## 0.9.16 — 2026-09-26

### OpenCode (v2+) transcript auto-capture

OpenCode sessions were only saved when the model remembered to call
`save_message` each turn — in practice it batch-saved once and then stopped.
OpenCode is now captured passively, like Hermes.

- New `opencode_capture`: read-only poll of `~/.local/share/opencode/opencode.db`
  (`$XDG_DATA_HOME` / `$OPENCODE_DB` honored), `session_message` table.
  Each poll reads only the last 30 s by the `time_created` index (row ids are
  text, `seq` is per-session, `time_updated` is unindexed); ids already handled
  inside that window are remembered, so late commits are still picked up.
  Assistant rows are only taken once `data.time.completed` is set — a
  still-streaming step is tracked by id until it completes, so a half-streamed
  answer is never frozen by the `opencode:<msg id>` dedup key. Only `text`
  parts are kept (reasoning/tool parts dropped); sub-agent sessions
  (`parent_id`) and non-message rows (`idle`, `model-switched`, …) are skipped.
  A row that fails to insert is retried without blocking later rows, and given
  up after 5 attempts; NUL bytes are stripped.
- Capture only arms on the v2 schema (`session_v2` present and the poll query
  succeeds). OpenCode v1.18.x shares the same `opencode.db` path but has no
  `session_v2`, so it stays on `save_message`. Repeated open/query failures
  disarm capture.
- OpenCode's MCP `clientInfo.name` is the generic `"cli"` (`"acp"` in ACP mode).
  It is normalized to `agent_platform = "opencode"` only when `clientInfo.version`
  matches a version recorded in that device's `opencode.db`. The same helper now
  feeds `memory_startup`'s current platform and every write path.
- `save_message` returns `skipped: "passive capture active"` for OpenCode while
  capture is armed (no duplicate rows).
- The "auto-captured" roster in the server instructions lists OpenCode only when
  capture actually armed on this device (OpenCode v1.18, Node without
  `node:sqlite`, or no OpenCode → unchanged, so those clients keep calling
  `save_message`).

## 0.9.12 — 2026-05-29

### Cold-path clusterer: local-only valid JSON (d_tag→p_tag auto-promotion finally fires)

The `clusterer` role (d_tag frequency clustering → p_tag auto-promotion) was the
only cold-path role calling the local model without a `json_schema`, so
Qwen3-14B returned free-form/invalid JSON and every run fell back to
no-clustering — auto-promotion never actually fired.

- Add `CLUSTER_SCHEMA` with an **object root** (`{ "clusters": [...] }`); a
  top-level array is rejected by strict `json_schema`. Mirrors the
  tagger/librarian/judge schema pattern.
- Pass `jsonSchema` + `enableThinking: false` to `callRole`; parse `obj.clusters`
  instead of a bare array.
- Raise `maxTokens` 512 → 4096 — 50-tag clustering output was being truncated
  mid-JSON (within the 8192 llama-server context).

Local-only; no grok involved. Verified: clusterer emits valid JSON and
retrotags rows on the first cycle after restart.

## 0.9.9 — 2026-05-23

### `search_memory` device scoping — "search wide, resume narrow"

New `device_scope: 'local' | 'global'` param (default `global`). `local` restricts results to the current device (`os.hostname()`), but pinned memories stay cross-device (`device_name = $N OR is_pinned = TRUE`) — mirroring the brief's device-scope + pinned-exempt precedent, since pinned facts are important regardless of context. Applied to both the vector/recency path and the ILIKE fallback.

Two bugs surfaced during the brief-continuity verification are fixed:

- `agent_platform: "*"` was a literal SQL match (`= '*'`) returning 0 rows, despite the startup brief documenting `"*"` as a cross-platform search. Now treated as no-filter.
- `device_name` was absent from `search_memory` results (the brief renders `@hostname`, but search dropped it). Added to the result schema, all three SELECTs, and all three row mappers.

Zero-config preserved: the server resolves the hostname; no per-client configuration.

## 0.9.8 — 2026-05-22

### Startup brief — budget cap + device-scoped continuity

Two-channel brief assembly so the client-injected MCP `instructions` block survives the client's ~2KB truncation while `memory_startup` carries the rich context.

- **Inject mode (Phase 1)**: `STATIC_INSTRUCTIONS` trimmed (1,436→565 chars); the auto-injected brief now guarantees header + Core Profile + pinned + active projects within `INSTRUCTIONS_MAX_CHARS` (default 1900) via budgeted line-fill, dropping Sub Profile / Recent in inject mode (they load lazily via `memory_startup`). Pinned hoisted above Sub Profile.
- **`memory_startup` continuity (Phase 2)**: previous-conversation continuity rides the uncapped `memory_startup` tool response, not a Claude-Code-only `SessionStart` hook — that hook attempt was built then reverted for violating the zero-config standard-env principle. `recent_messages_current` scoped to the current device (`device_name = os.hostname()`); preview length decoupled from the inject cap (`MAX_PREVIEW_STORE` 500 / `PREVIEW_RECENT` 300 / `PREVIEW_COMPACT` 100); `BRIEF_MAX_CHARS` 3000→8000 so the thicker Recent is not dropped.
- **Proactive resource use**: brief footer + STATIC instructions nudge agents to call `search_memory` on named-entity mentions and before assuming past preferences/decisions.

The `instructions` pointer drives every platform (Claude / Codex / Gemini) to call `memory_startup`, so all clients get rich device-scoped continuity with zero client config.

## 0.9.7 — 2026-05-22

### Librarian v2 — daily user profile promotion

Background job that reads 50 recent `role='user'` messages once per day and promotes stable identity/preference facts to `users.core_profile` / `users.sub_profile` via qwen3.6:35b-a3b (local, Q4_K_M).

Gate logic: `LIBRARIAN_ENABLED=true` + 30 new messages since last run + 24h cooldown. Attempt timestamp written immediately on every call (hammer prevention); `msg_count_at_run` updated on success only so gate re-opens after failed run.

Hardened against two known qwen3.x failure modes: (1) `response_format: json_object` → empty content bug — omitted entirely, relying on callSpec local-case fence stripping; (2) reasoning token exhaustion at 8k — bumped to `max_tokens=32768`. Added JSON-in-string guard (rejects `sub_profile` that starts with `{` or `[`) and null protection (`parsed.field ?? existing` so model returning null preserves existing data).

### Added
- `src/librarian.ts` — full rebuild (v1 → v2): gate check, per-attempt `last_run_at` update, 32k token budget, null guard, JSON-in-string guard, prose-only system prompt rule
- `src/migrations/023_librarian_gate.ts` — adds `librarian_last_run_at TIMESTAMPTZ` and `librarian_msg_count_at_run BIGINT` to `users` table
- `src/cold_path/worker.ts` — wires `maybeRunLibrarian()` into cold path tick (gated by `LIBRARIAN_ENABLED`)
- `src/model_registry.ts` — `librarian` role in ROLE_REGISTRY; local provider singleton client; `callSpec` exported as public API; qwen3 thinking flag support
- `src/cold_path/tagger.ts` — grok fallback for local tagger failures (`LOCAL_GROK_FALLBACK=true`)
- `.env.example` — `LIBRARIAN_PROVIDER`, `LIBRARIAN_MODEL`, `LIBRARIAN_ENABLED` added

### Configuration
- Ollama tuning applied on 몰타르 서버: `FLASH_ATTENTION=1`, `KV_CACHE_TYPE=q8_0`, `TIMEOUT=900`, `KEEP_ALIVE=60m` via systemd drop-in; Modelfile `num_ctx 16384` (down from 131072 — VRAM 97% constraint), `temperature 0.65`, `repeat_penalty 1.1`

## 0.8.1 — 2026-04-28

### Skill injection eval harness (dev tool)

Adds `npm run eval` — a curated scenario suite for `getInjectableSkills` filter behavior. Runs 6 multi-axis scenarios (project × model × platform intersections, multi-project unions, status filtering) against the live DB. Cleanup via `applicable_to.eval_run_id` metadata tag — no test fixtures can leak into production data.

This is a development tool, not user-facing API. No schema change, no MCP tool exposure, no metric → behavior wiring. Decision basis: 3-way design meeting #2 + advisor surfaced that v0.8 ships multi-axis filter logic that has never executed against real production data (all 4 existing skills are `applicable_to = '{}'`). The harness exercises the unrun code paths.

Discriminator before scope finalization: 4 production skills, all match-all shape, 2 distinct sessions across 148 memories. Production telemetry counters (the lighter alternative path) would yield no signal for months. Eval harness produces signal in the first run.

### Added
- `src/eval/runner.ts`, `src/eval/scenarios.ts`, `src/eval/index.ts` — scenario runner and initial 6-scenario suite
- `npm run eval` script (compiles via existing `npm run build` esbuild pipeline, then runs)
- `build.mjs` extended to bundle eval entry point alongside index + migrations

### Out of scope (settled)
- Coverage of full `memory_startup` briefing assembly (`tools.ts:140-163` wrap) — eval harness exercises `getInjectableSkills` filter only
- Single-axis scenarios (project-only, model-only, platform-only) — already covered by `scratch/test_v08_project_scoping.ts`. The harness focuses on intersections to earn its keep
- Production telemetry: counters, use_count auto-increment, agent self-reporting — all deferred until real-user signal exists

### No npm publish
0.8.1 ships to git only. No user-facing API change, so no registry update warranted. 0.8.0 remains the latest published version.

## 0.8.0 — 2026-04-28

### Project scoping for skills (Phase 1 of Project Rules Engine)

Skills used to leak across projects. A skill formed from Project A memories would auto-inject into a Project B `memory_startup`, regardless of project context. This shipped a single-axis correctness fix using JSONB extension — no schema migration.

A 3-way design review (Codex GPT-5.5, Gemini-3-Pro, advisor) produced an unanchored ranking. Advisor flagged that two consultants had piggybacked on Opus's prompt anchor (Skill Application Telemetry was the original direction), and surfaced Project Rules Engine as the under-weighted candidate. Code evidence confirmed the leak: `getInjectableSkills` had no project filter, `applicable_to` JSONB only checked `models` and `platforms`, and the curator never propagated cluster `projectId` to the resulting skill.

### Added
- `applicable_to.projects` JSONB key — opt-in project scope. Skills with this key only inject when `memory_startup` is called with a matching `project_key`. Skills without it (the existing default `'{}'` shape) match all projects (backward compatible).
- `memory_startup` and `memory_save_skill` tools accept a new `project_key` argument.
- `getInjectableSkills(ctx)` accepts `project_key`; SQL filter respects null-tolerant pattern (NULL = no filter).
- Curator propagates cluster `projectKey` to `SkillCandidate.project_key`. `getPersistedSkillFields` merges it into `applicable_to.projects` if the auditor didn't already specify one.
- Accumulate path (similarity ≥ 0.9) now unions project keys via `jsonb_set`. Rules: NULL project → no-op; existing match-all (no `projects` key) → don't narrow; project already in array → no-op; otherwise append. Branch and create paths inherit the candidate's `applicable_to` directly (no merge needed).

### Backward compatibility
Verified against live DB before ship: all 4 existing skills had `applicable_to = '{}'`. They continue to inject for any `project_key` (or none).

### Skill Auditor inference (deferred — principled)
The auditor's system prompt could in principle infer `applicable_to.projects`, but it adds no information the cluster's projectId doesn't already carry, and adds hallucination risk. Phase 2 may revisit if there's evidence the cluster signal is ambiguous.

### Verification
`scratch/test_v08_project_scoping.ts` — 11/11 against Neon: read filter (4 cases) + backward compat (2 cases) + write propagation (1 case) + merge semantics on accumulate (3 cases: union, match-all preservation, null-project preservation).

## 0.7.0 — 2026-04-28

### Breaking schema change: `trust_weight` infrastructure retired

The `trust_weight` / `effective_confidence` columns existed since v0.5 but were never wired into ranking, contradiction resolution, or any automated decision — only displayed as a label in `memory_search` results. Setting `trust_weight` to 0.5 vs 0.98 produced identical system behavior.

After a 3-way design review (Codex GPT-5.5, Gemini-3-Pro, advisor), all three independently recommended deprecation over wiring. Two killer risks for the wiring path: (1) `effective_confidence` was computed once at write time and frozen — demoting a model later would not recompute past memories, so any ORDER BY on it would rank on stale historical artifacts; (2) auto-defaulting unknown models to 0.8 produces a "SOTA Penalty" — newly released frontier models would suppress their own facts under older benchmarked models until manually seeded.

The narrow audit gate (`fact_type='learning' AND importance>7`) was kept intentionally — those facts are externally groundable via Tavily+Exa. Subjective fact types (preference / profile / project / decision) cannot be grounded externally and so do not benefit from audit expansion. Audit scope is correct as-is, not deferred.

### Removed
- `models.trust_weight` column (migration 017)
- `platforms.trust_weight` column (migration 017)
- `memories.effective_confidence` column (migration 017)
- `computeEffectiveConfidence` function in `librarian.ts`
- `DEFAULT_TRUST_WEIGHT` constant
- `effective_confidence` field from `memory_search` SELECT and result label

### Added
- Auto-registration of unknown author models in `resolveModel` (`src/librarian.ts`). Two-branch behavior:
  - **Prefix-known** (`claude-*` / `gpt-*` / `o1-*` / `o3-*` / `gemini-*` / `grok-*`): provider is inferred, model is auto-INSERTed, `author_model_id` FK is populated.
  - **Prefix-unknown** (custom or non-standard models): falls back to `author_model_id=NULL` with a warning. This is the same behavior as before — auto-register does NOT eliminate NULL completely, only for models that match a known provider prefix.
- `inferProvider` is now exported from `src/model_registry.ts` (single source of truth for prefix → provider mapping, reused by both env-config inference and DB auto-registration).

### Migration
Migration 017 runs automatically on first server startup against existing databases. It uses `DROP COLUMN IF EXISTS` and is idempotent. **Note: column drops are not reversible without a backup**, so users on 0.6.x who want to roll back should take a snapshot before upgrading.

### Internal
- `ResolvedModel` and `ResolvedPlatform` interfaces no longer carry `trust_weight`. The `resolveModel` / `resolvePlatform` functions remain (they're still used by `skills.ts` for provenance FK lookup).

## 0.6.3 — 2026-04-28
- Per-call `agent_curator_id` for multi-persona harnesses (commit `151f2bf`).

## 0.6.2 — 2026-04-28
- Drop env-static `AGENT_MODEL`, capture curator model per-call (commit `16ab470`).

## 0.6.1
- Split Producer (`author_model`) and Curator (`agent_*`) provenance (commit `59ca76c`).

## 0.6.0 — 2026-04-27
- First npm publish (commit `53bb9ba`).
