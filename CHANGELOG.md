# Changelog

## 0.9.41 — 2026-11-21

### Prompt recall now works for Buzz messages

Before turning the prompt hook on for Mortar's Buzz agents, we replayed 40 of
Kuu's real Buzz messages (mixed channels, two weeks) against the production
database, read-only. With 0.9.40 the hook recalled nothing for any of them:
`cleanPromptForRecall` stripped only the `<context>` block, so the rest of the
envelope still began with `<thread-context>` or `<buzz-event>` and every
message was skipped as `wrapper` (40/40, confirmed with the installed binary).

- `recallQuery` searches with the current turn only: channel, sender and the
  message text, the same shape `buzzEmbeddingText` gives stored rows. The end
  of the message text is found from the bottom of the event (closing tag, then
  `Parsed:`, then `Tags:`), so `<config>` lines, pasted `Tags: [[…]]` /
  `Parsed:` / `Content:` log lines and quoted `--- Event n ---` lines inside a
  message stay part of it (Codi's review of the first draft: a 100-character
  XML question was counted as 14). The DM `Tags:` line, which has no 64-hex id
  and so is left in place by `buzzEmbeddingText`, is dropped as the tail. An
  event shape it cannot read falls back to `buzzEmbeddingText` without the
  length gate. New `buzzTurnText` export finds the turn block.
- Short Buzz messages are skipped (`short-buzz`) when the message text minus
  mentions, links and images is under 20 characters
  (`MEMORY_RECALL_MIN_BUZZ_CHARS`). A bare "@Kuu at Mortar" matched unrelated
  rows at 0.73 and "응 그래 그렇게 하자~" at 0.70. Raising the similarity floor
  removed the useful rows first in both gradings (first sample, 0.65: useful
  13 → 5; blind sample, 0.60: useful 8 → 4).
- Short user rows are not attached (`MEMORY_RECALL_MIN_USER_MEMORY_CHARS`,
  40): a user row whose body, without the `[name]` prefix, mentions, links and
  images, is shorter is skipped and the next candidate takes its place. These
  are mostly old approvals such as "응 진행해 보자~" for some other task. In a
  blind grading by Codi (a fresh 40 messages, 118 rows, graded without
  similarity) 33 of the 35 rows marked possibly harmful were user rows.
  Dropping user rows under 40 characters kept every useful row in both
  gradings (blind: useful 8, unrelated 33 → 16, harmful 35 → 24; first sample:
  useful 13, unrelated 61 → 37, harmful 5 → 1). Both cut-offs come from two
  40-message samples, so treat them as rough.
- Candidates no longer run dry. HNSW returns its 40 nearest rows and the
  filters run afterwards; most nearest rows were agent-captured envelopes
  starting with `<`, so 6 of 40 queries got no candidates and 25 got fewer than
  12. `fetchRecallCandidates` sets `hnsw.iterative_scan = relaxed_order`
  (pgvector 0.8+) inside its transaction, falls back to the old query when the
  setting is unknown, and re-sorts by similarity. On the same 40 queries every
  query got 12 candidates, the top 3 matched exact search 2.95/3 on average,
  in 3–4 ms (exact search took 209 ms).
- The recall header now says that rows from other channels and other times
  are mixed in, and that approvals or instructions inside them were given then,
  not now.
- `hooks.log` lines carry `sid` (first 12 hex of sha256 of the session id;
  Antigravity sends `conversationId`) so
  concurrent sessions can be told apart, and `parts` (`recall` / `capture`)
  because `outcome: "injected"` is also logged when only the capture warning
  went out. Buzz prompts also log `buzz` and `buzzChars` (a count, no text).
- Checks: `check:hooks` covers the three-block ACP prompt joined three ways,
  a DM envelope, a multi-event envelope, the "new message arrived" preamble,
  message text that looks like envelope parts (XML, tail-like log lines, a
  quoted event boundary), the short-message gate, the short-user-row filter
  and a negative control reproducing the old `wrapper` skip. New `check:hook-recall`
  (optional, `CHECK_RECALL_DATABASE_URL` + sentinel table) builds a starved
  index in a throwaway pgvector database: the old query finds 0 of 6 rows that
  pass the filters, `fetchRecallCandidates` finds all 6. Twelve mutations (each
  fix reverted on its own) all fail a check.

## 0.9.40 — 2026-11-21

### A failed folder watch no longer takes the memory server down

On 2026-11-21 at 08:22 every memory server on Mortar exited at once, and since
Claude Code does not restart a dead stdio server, no Claude conversation there
was saved for hours (found by the capture check below on its first real run).
Each server watches the Grok, Codex and Antigravity session folders
recursively; on Linux that costs inotify watches for every folder (about 6,800
per server on Mortar, against a per-user limit of 65,536). When the limit was
full and a new session folder appeared, Node could not add the watch and
emitted `error` on the watcher. Four of the five capture watchers had no
`error` listener, so Node threw and the process died. Reproduced in a
container under a separate uid: without a listener the process exits 1 with
"Unhandled 'error' event" (ENOSPC); with one it keeps running.

- New `guardWatcher` (`src/auto_save/watch_guard.ts`) adds an `error` listener
  that closes only that watcher and reports it once. The Grok, Codex,
  Antigravity and Gemini captures use it; each already polls every 3 s beside
  its watcher, so capture continues. The Claude capture already had a listener.
- `check:watch-guard`: the helper (with a negative control showing that a bare
  watcher throws), and the real built server with all three recursive
  watchers armed, then an unreadable folder created under each root (EACCES
  takes the same `error` path as ENOSPC). The server must stay up and log the
  closed watchers; with the previous capture modules it dies.
- Not changed yet: how many watches each server uses.

### Hooked Claude Code sessions warn when the conversation is not being saved

0.9.39 stopped hooked Claude Code sessions from calling `memory_startup` at the
start, so they no longer saw its "this session is not being captured" warning.
Only the server knows its capture state, and the hook runs outside it, so the
hook checks the result instead.

- Once per session, `hook prompt --client claude` reads the end of the session
  file (`transcript_path`), keeps the lines `jsonl_capture.parseEntry` would
  store that are 60 s to 30 min old (resumed sessions may contain old parts
  that earlier capture gaps missed), and looks up their `external_uuid`s
  (`claude-code:<session>:<line uuid>`).
- One hit means the session is fine. With no hit, lines whose role and text
  are already stored for the same session are set aside: the capture stores
  each text once per session, so a question re-recorded under a new uuid is
  expected to be absent (review by Codi). If at least two lines with different
  text remain, the session is not being saved, and the hook adds a warning,
  placed before the recall text so the length cap never cuts it, asking the
  model to tell the user once and naming the `backfill-claude` command for
  that file. One line, only re-recorded text, unreadable or non-regular files
  (opened without blocking, so a FIFO cannot stall the hook), a missing path
  or database errors decide nothing; the next message tries again.
- The verdict is written to
  `~/.local/state/mcp-agents-memory/capture-check/<session>.capture-check.json`
  (mode 600) just before the hook prints, so a timed-out warning is retried.
  It is only ever created, never opened if something is already there
  (`O_CREAT|O_EXCL`, no symlink following, non-blocking): a symlink, FIFO or
  foreign file in its place is left alone, the warning still goes out, and
  the log notes `markerError` (review by Codi).
  Later messages see the file and skip the database entirely. Pruning after
  two weeks removes only files with that name pattern and our own tag inside,
  never anything else in the folder (review by Codi). Short replies still skip
  the database unless a check is pending.
- Recall and the check run side by side, each with its own time budget just
  under the hook deadline, and settle separately: a failed or slow recall
  (no embedding key, an embedding server that does not answer) still lets a
  finished warning through (review by Codi).
- Codex and Antigravity are not checked. `MEMORY_CAPTURE_CHECK=0` turns it off.
- `check:hook-capture`: line selection, verdicts, marker files, the process
  contract without a database, and, with `CHECK_CAPTURE_DATABASE_URL` pointing
  at a throwaway database (the `__disposable_test_db__` sentinel table is
  required), the warning, the once-per-session marker, re-recorded text, a
  slow recall, and positive controls filled by the real `backfill-claude`
  code. Reverting each review fix makes the check fail.
- Found on first real use: the Mortar outage described above.

## 0.9.39 — 2026-11-21

### The start brief no longer arrives two or three times in Claude Code

With the SessionStart hook installed, a Claude Code session received the full
brief from the hook, a second, compressed copy in the MCP `instructions` field,
and an instruction to call `memory_startup` at session start, which would bring
a third copy (reported by a Claude Code session on the Mac Studio: four pinned
memories appeared in both places).

- The hook's brief now says it is the same brief `memory_startup` returns, made
  at session start, so the model need not call the tool for it. This applies to
  every hook client.
- When the connecting client reports itself as exactly `claude-code` and the
  user's Claude settings (`~/.claude/settings.json`, `CLAUDE_CONFIG_DIR`
  respected) contain our SessionStart hook, the server sends instructions
  without the compressed brief, and the start line becomes conditional: call
  `memory_startup` once only if no "mcp-agents-memory 시작 브리핑" text is at the
  top. That fallback covers sessions whose hooks the settings file cannot show
  (`--settings`, project hooks, SDK sessions). The check counts only a command
  in our exact generated form (0.9.37/0.9.38 `print-config` or the installer)
  in a `SessionStart` group that also runs on a new session (no matcher, `*`,
  or a `|`-list containing `startup`), and treats `disableAllHooks` in
  `settings.json` or `settings.local.json` as no hook. Anything uncertain keeps
  the full instructions (review by Codi: an unrelated `echo hook session-start`,
  `disableAllHooks` and a `resume`-only matcher had dropped the brief).
- Codex, the desktop app (`local-agent-mode…`) and Antigravity keep the full
  instructions: right after installation Codex hooks wait for `/hooks` trust,
  and the other two have not yet been checked end to end. `MEMORY_HOOKS_OFF=1`
  also keeps the full instructions.

The client name is only known in the `initialize` request, so the server wraps
the SDK's initialize handler and hands the request to the original
`_oninitialize`, which still records the client info. If that internal method
is missing or anything fails, the default instructions are used.
`check:instructions-dedup` starts the built server with a fake home and checks
all five cases plus `tools/list` after the handshake, so an SDK upgrade that
breaks the wrapper is caught.

## 0.9.38 — 2026-11-21

### Memory hooks for Codex and Antigravity, and an opt-in installer

The 0.9.37 Claude Code hooks now serve three clients from one engine:
`hook <session-start | prompt> --client claude|codex|agy` (no `--client` means
`claude`, so 0.9.37 settings keep working).

- **Codex CLI** (0.171.0): the same `SessionStart` / `UserPromptSubmit`
  `additionalContext` JSON as Claude Code. Codex replaces context above about
  2,500 tokens with a file and a preview, so Codex output is capped at 3,000
  characters (`MEMORY_HOOK_CODEX_MAX_CHARS`) and the start brief is built in the
  budgeted inject format. Verified against a real Codex run whose model request
  carried both the brief and the recalled records as developer context. Codex
  only runs user hooks after the user trusts them in `/hooks`; the installer
  never grants that trust.
- **Antigravity** (`agy` 1.5.13): reads `lastUserInput`, prints
  `{"injectSteps":[{"systemMessage":{"systemMessage":…}}]}`, and `{}` when there
  is nothing to add or the hook gives up. Antigravity has no prompt-submit
  event, so the per-message hook is registered on `PreInvocation` and acts only
  on the first model call of a turn (`invocationNum` 0). A real `agy -p` run
  showed hook commands run through a shell and both injected messages reached
  the model.
- **Grok** (1.0.89) fires `SessionStart` / `UserPromptSubmit` but discards hook
  output, so it is not given hooks; the installer adds MCP tool-use guidance to
  `~/.grok/AGENTS.md` instead. Grok also loads Claude hook settings, which the
  installer warns about.

New `mcp-agents-memory hook install [--client …] [--yes] [--dry-run]`, also
offered at the end of interactive `setup` (default no; piped setup only prints
the command). It detects the installed clients, asks per client, and merges only
the memory-owned handlers into `~/.claude/settings.json`,
`$CODEX_HOME/hooks.json` (default `~/.codex`), `~/.gemini/config/hooks.json`
or `~/.grok/AGENTS.md`, keeping every other setting and hook. It recognises the
0.9.37 `print-config` commands and replaces them instead of adding duplicates,
refuses malformed JSON and symlinked settings files, keeps the exact previous
bytes (mode 600, latest two per file) under
`~/.local/state/mcp-agents-memory/hook-backups/`, refuses an `npx` cache as the
hook entry, and reports `configured`, `trust-pending` (Codex), `unsupported`
(Grok) or `planned` (`--dry-run`). Installing the npm package never edits client
settings. Installer by Codi (#42).

Hook commands now pin a node path that survives upgrades: a Homebrew versioned
path (`…/Cellar/node/26.0.0/bin/node`, which disappears on `brew upgrade` and
silently stopped the hooks) is replaced by `<prefix>/opt/node/bin/node` or
`<prefix>/bin/node` when that link resolves to the same file.

End to end, the installer's own output was loaded into a real Claude Code
`-p` session and a real `agy -p` session: both injected the start brief and the
per-message records, and the model read both. Reinstalling changed nothing.

## 0.9.37 — 2026-11-20

### Claude Code hooks: full start brief and recall on every message

New `mcp-agents-memory hook <session-start | prompt | print-config>`.

`hook session-start` (SessionStart) puts the full start brief at the top of a
session. Until now the brief only travelled in the MCP `instructions` field,
which Claude Code cuts at about 2,000 characters; the full brief on the
production database is about 6,000 characters, and hook output may be up to
10,000. If pinned memories push it past that, the hook falls back to the
budgeted inject format and then hard-caps at 9,500 characters, because Claude
Code replaces longer hook output with a 2,000-character preview.

`hook prompt` (UserPromptSubmit) embeds each message you send and adds at most
three similar past records, labelled as automatic search results that may be
unrelated. It skips slash commands, replies shorter than 8 characters, machine
messages (task notifications and other wrappers), records shorter than 40
characters or starting with `<`, and records from the last 30 minutes. A cosine
similarity floor of 0.5 decides whether anything is added: in an 11-prompt
probe relevant hits scored 0.50–0.66 and unrelated prompts at most 0.42–0.47,
but junk also scored up to 0.66 for keyword-heavy questions, so the floor and
count are env-tunable (`MEMORY_RECALL_MIN_SIMILARITY`, `MEMORY_RECALL_LIMIT`)
and the hook log records each call's top similarity for tuning. End to end on
the database host a call takes 325–644 ms (median 345 ms, 10 runs).

Both hooks always exit 0 (exit 2 would block the user's message), print exactly
one JSON object or nothing (every `console.log` is redirected to stderr), and
give up silently after 3.5 s / 6 s via `process.exit`. Each call appends one
line to `~/.local/state/mcp-agents-memory/hooks.log` — event, outcome, time,
row ids, top similarity — and never the message text. `MEMORY_HOOKS_OFF=1`
turns them off.

Claude Code stores injected hook context as `attachment` transcript entries,
which the JSONL capture already skips; a real session run through
`parseEntry` produced only the user and assistant turns, so recalled records
are not saved back into memory.

`hook print-config` prints the `hooks` block to merge into
`~/.claude/settings.json` with `MEMORY_CONFIG_PATH` pinned as an absolute path
(a relative path would be read from each session's working directory, and a
project `.env` with its own `DATABASE_URL` would otherwise win). Each command
ends in `|| true`, so a failure before the hook code runs — a missing build,
a module that cannot load — still exits 0. It never edits the file.

An unreadable config file (for example no read permission) used to throw
while `db.ts` was being imported — before any of the hook's own error handling,
so the hooks exited 1 and even `MEMORY_HOOKS_OFF=1` could not stop them. Only
`mcp-agents-memory hook …` now survives that: it records the error, and both
hook events end with no output and exit 0 before touching any database — also
when the environment still carries a `DATABASE_URL`, which would otherwise be
used. Every other command (the MCP server, `migrate`, scripts) keeps stopping
at import as before, so an inherited `DATABASE_URL` is never written to by
mistake. `hook print-config` reports the error and exits 1.

### Claude Desktop sessions are labelled `claude-desktop`

The desktop app connects with MCP client names starting with
`local-agent-mode`, which were stored verbatim as `agent_platform` (for example
`local-agent-mode-mcp-agents-memory`). They are now normalized to
`claude-desktop`; the "capture is not attached" warning accepts both the
normalized and the raw name. Existing rows keep their old label (6 rows on the
production database at release).

## 0.9.36 — 2026-11-14

### Claude sessions whose folder appears late are captured

Claude Code creates `~/.claude/projects/<slug>/` and the session transcript
when the first message is sent, but the session's MCP server starts when the
session is opened. The capture looked for the folder for ten seconds and then
gave up with a line in the server log, so a session opened and left for more
than ten seconds before the first message lost every turn. On a MacBook the
desktop app's sessions showed gaps of 12.7 and 23 seconds; one session lost
about 33 hours of conversation.

After the ten-second fast retry the capture now keeps waiting: it watches
`~/.claude/projects` itself (not recursively) and checks for the folder every
3 seconds, and attaches when it appears. A server whose working directory is
`/` is the desktop app's app-wide connector, not a session server; it keeps
waiting harmlessly and its sessions are captured by their own servers.

A transcript file that was created up to 60 seconds before the server started,
or any time after, is now read from its first line when the capture attaches.
Before, every file that already existed at arm time started at its end, so the
first turns of a folder found late were lost. Re-reading is harmless: rows are
keyed by `external_uuid`. Filesystems that report no birth time keep the old
behaviour.

One unreadable transcript no longer stops the capture of every file listed
after it — each file's flush now fails on its own and is logged once — and a
watcher error closes the watcher and falls back to polling instead of crashing
the server.

Desktop-app sessions (`entrypoint: "claude-desktop"`) are now stored with venue
`terminal` like other one-to-one sessions, instead of `auto`.

### `backfill-claude` stores conversation the capture missed

`mcp-agents-memory backfill-claude [--dry-run] <session.jsonl> [...]` reads a
transcript from the start and stores only the lines that are not in the
database yet, so it is safe to run twice. Each row keeps the line's own
timestamp as `created_at` — a backfill stamped "now" would push week-old
conversation to the top of the start brief — and this machine's hostname as
`device_name`, so run it on the machine that holds the file. Subagent
transcripts (`subagents/*.jsonl`) are refused, matching the live capture, and
the command exits non-zero if any line failed to insert.

### `memory_startup` warns when Claude capture has not attached

A capture failure used to appear only in the server log. `memory_startup` runs
after the first message, when the session's folder must already exist, so it
checks once more and, if the client is Claude Code (`claude-code`) or the
desktop app (`local-agent-mode-…`) and the capture still has not attached,
starts its answer with a warning that names the working directory and what it
is waiting for and points to `manage_knowledge` and `backfill-claude`. Servers
started by other clients and the desktop app's `/` connector stay quiet.

### Editing a memory sends it back to the tagger

`manage_knowledge` `update` cleared the project tag, keywords and embedding but
left `tag_processed` set. The cold path only tags rows where it is false, so an
edited memory got a new embedding and never got its tags back. `update` now
resets `tag_processed` as well, matching the two Buzz re-clean paths that
already did.

## 0.9.35 — 2026-11-13

### `mcp-agents-memory setup` works again, and `migrate` runs on an empty database

Since the RESPEC v1 rewrite, `setup` only printed "Setup wizard is being
rewritten" and exited with an error, while `help` still promised that it writes
the config and runs the migrations. A new install had to hand-write `.env`, and
even then `migrate` stopped at the first file: `005_provenance` upgrades the
pre-RESPEC `facts`/`memories` tables and fails when they don't exist.

`setup` now walks through three steps. It asks how to reach PostgreSQL (host,
port, user, password, database — or one `DATABASE_URL`) and checks the
connection and that pgvector is available before anything is written; a failed
check can be retried. It asks for `OPENAI_API_KEY` (optional; checked with one
embedding call) and `USER_NAME`. It then writes
`~/.config/mcp-agents-memory/.env` (directory 700, file 600, written
atomically), runs the migrations, creates the user row and prints a short
health check. If the file already exists it asks before changing it, replaces
only the keys it manages and keeps every other line; a config that uses an SSH
tunnel is left alone with a note, since setup doesn't manage tunnels. Values are
read and quoted with the same dotenv parser the server uses, and the file is
read back before it replaces the old one, so what gets saved is exactly what was
checked. Passwords, URLs and keys are never echoed — typing shows `*`, at most
24 of them. Piped answers work for scripted installs and are not echoed either.

`migrate` skips `005`–`018` when neither `facts` nor `memories` exists. `019`
creates the whole RESPEC v1 schema by itself, and databases that already went
through the old steps have each one recorded in `migration_history`, so nothing
changes for existing installs.

Checked on a fresh pgvector database: wizard through a real terminal and through
piped answers, a wrong password then a retry, a malformed URL then a retry, a
password containing `$ ' " # \` read back unchanged, a second run over an
existing config (answering no, then yes), an SSH-tunnel config refused, then the
MCP server started from the written config — save, meaning-based search and the
startup briefing all returned the new row.

## 0.9.34 — 2026-11-06

### The tagger's decision flow is separable from the database, and three tagging arms were measured (#36)

Comparing tagging approaches means running the tagger many times over stored
rows, which is exactly what must not touch the production tables. Injecting a
few functions was not enough: `tagger.ts` imports `db` statically, as does
`dtag_promoter.ts` behind it, and `SYSTEM_PROMPT` reads `getPrompt` at module
level — the imports run whichever functions you swap. The module had to split.

`tagger_core.ts` now holds prompt assembly, the decision flow and parsing, and
imports exactly one module (`project_registry.js`, itself import-free).
`tagger.ts` stays the database adapter: same `tagMessage(input)` signature and
return shape, assembling ports and calling `runTagger`. Write capability is in
the type rather than in a runtime check — `getOrCreateTag` lives on
`OperationalPorts`, and `EvalPorts` declares it `undefined`, so the tag-creation
path is closed at compile time for anything running an evaluation.

Two behaviours were deliberately left as they were. The alias-chain query
differs between its two call sites (the registry path caps recursion at depth
20, the non-registry path has no cap); `resolveCanonical(name, { maxDepth })`
carries each site's current value instead of unifying them. And
`newly_created_p_tag_name` is still filled whenever the NEW path runs, even
when get-or-create returned an existing id; the create-vs-reuse distinction is
reported only in the evaluation-only `TaggerTrace`.

On top of that split, a file-based runner compares three arms: the current
tagger alone (A), the same tagger given an agent's candidate and evidence (B),
and the agent's candidate alone (C). Inputs are files, and every run records
their sha256 alongside the arm list. It does not call a model by default —
canned responses exercise the machinery, and `--live-model` is required for real
calls, at which point the model registry is imported dynamically. The no-db
check follows that dynamic import too, confirming the runner cannot reach
`db.ts` or `pg`. `TagInput.agentCandidate` is optional and `agentCandidateLine()`
returns an empty string when it is absent, so prompts on existing call paths are
byte-identical; the equivalence check holds that.

The measurement did not establish an accuracy improvement. Of 30 cases, 16 were
scorable, and the arms scored 12, 13 and 12 — a one-case difference with the
run-to-run variance unmeasured. What it did surface is that none of the three
arms abstains: across eight rows whose subject is outside the registry, all
three attached an existing project tag, and the candidate generator returned an
empty candidate zero times in thirty despite the schema allowing it. Those eight
rows cover three projects and arms B and C share one candidate file, so this is
a direction to test next — abstention, evaluated together with whether raising
it starts dropping correct projects — not a measured rate.

### A conversation's venue is read from envelopes that begin with the event itself (#37)

`venue` records where a conversation happened; `agent_platform` records which
path stored it. A row saved through the MCP `save_message` tool can arrive as a
bare Buzz turn — body starting at character one with `<buzz-event
type="@mention">`, no `<base>` manual and no `<context>` block. The venue reader
looked only for those two shapes, so it returned null even though the envelope's
own header spells out `Channel: <name> (#uuid)` three lines down. Thirty-nine
stored rows have that shape, all of them `codex-mcp-client`; thirty-seven
inherited a venue from an earlier Buzz turn in the same session, and two had no
earlier turn and so recorded nothing.

The reader now falls back to the envelope header, but only when no `<context>`
was found at all — a turn whose `<context>` is present but unreadable keeps its
previous outcome. The opening tag decides how the body is read. A single
`<buzz-event>` is one event and its event-boundary lines are never consulted,
because quoted prose containing `--- Event 2 ---` would otherwise displace the
real header and the channel named *in the quotation* would become the venue. A
`<buzz-events count="n">` bundle is split on those boundaries, each event's
channel is resolved on its own, and a venue is recorded only when every event
agrees; an event whose header is truncated or whose channel is a bare uuid makes
the whole bundle unreadable rather than letting the first event's name stand.

Reading only named channels is the load-bearing restriction.
`looksLikeBuzzTurn` was left untouched for the same reason: a channel-less
`"buzz"` would be worse than nothing, because the captures treat their own
reading as authoritative over the session's remembered channel — `venue = own ??
previous` in one, `if (own) previous = own` in three others. The 532 rows whose
envelope opens with `<new-message-arrived-…>` name their channel by uuid only,
and those are precisely the rows that would have been demoted. A header naming
the channel `DM` maps to `buzz:dm`, matching what the `<context>` path produces
from `Scope: dm`; every one of the 382 rows with that header already carries
that venue.

Running old and new readers over 12,804 candidate rows separates into 39 rows
that gain a value and none that lose or change one. Thirty-seven of the 39 agree
character-for-character with what is already stored, and the remaining two are
the rows that had nothing; those two were backfilled, venue column only.

The same three columns are now described consistently. The data-model table had
no row for `venue`, `device_name` or `external_uuid` at all, which is where the
confusion started: `venue` is the conversation space, `agent_platform` is the
collection-or-execution path (`buzz` meaning relay-ingested, so the execution
environment of such a row is unknown), `device_name` is the machine that
captured the row and not the device someone typed on. The `search_memory` tool
descriptions say the same, including that a `local` device scope still returns
pinned rows whose `device_name` is null.

## 0.9.33 — 2026-11-03

### Only the cold-path owner drains on shutdown (#35)

`drainColdPath()` runs on every MCP server shutdown, and it checked neither
the advisory-lock singleton nor `COLD_PATH_ENABLED`. Any machine's server
would therefore tag and embed whatever rows were pending when the editor
quit — including rows captured on other machines.

Observed: quitting Codex on a Mac picked up three pending rows, one of them
captured on the machine that runs the cold path. The Mac has no local
llama-server, so the `local` tagger failed and the grok fallback ran into a
missing `XAI_API_KEY`, leaving `cold_error = "tag: XAI_API_KEY missing"` on
all three. The real daemon retried and cleared them within six minutes, so
nothing was lost, but it recurs on every quit — and that machine's `.env`
already said `COLD_PATH_ENABLED=false`, which is to say 0.9.32's opt-in gate
does not reach this path.

The drain now runs only for a process that acquired the cold-path lock. The
flag is sticky: shutdown releases the lock *before* draining, so testing
`lockClient` would have disabled the dedicated daemon's own drain — the one
case that should keep working. `check:coldpath-drain` points the config at an
unreachable database, which makes the distinction exact rather than timed: with
the guard the call returns 0 without touching the database, without it the call
raises `ECONNREFUSED`.

## 0.9.32 — 2026-11-03

### The model label stops coming out as `unknown` on the Codex desktop app (#33, #34)

A captured assistant row records which model answered. That value exists in
exactly one place in a Codex rollout — `turn_context.payload.model`; the
`session_meta` payload carries `originator`, `cli_version` and
`model_provider`, but no model. The `turn_context` line appears once near the
top of the file and then only when the turn configuration changes.

The capture arms a rollout at its current size when the file already exists,
so that an old session is not bulk-inserted. The desktop app writes the
session preamble — manual plus tool schemas, about 179 KB in the observed
case — and *then* starts the MCP server, so that one line sits in the skipped
prefix and the model was never seen. The CLI creates its session file after
the server is up, reads from offset 0, and was therefore unaffected: the
difference was arming order, not a code path.

`state_5.sqlite` already answers the question. Its `threads` row — the same
row the platform label is read from since 0.9.31 — has a `model` column, and
across the twelve most recent sessions it matched the rollout's last
`turn_context.model` every time, including a session with eight of those
lines. The arming code now reads platform and model in one query and seeds the
model from it; a `turn_context` encountered later still overrides it, because
per-turn accuracy is higher there (a mid-session model switch leaves
`threads.model` holding only the final value).

Both arming sites do this. There are two — the start-up snapshot of existing
rollouts and the flush loop's discovery of new ones — and the first fix
covered only the second, which is to say only the case that already worked.
`check:codex-arm` now drives the real `captureSessionStart` against a
temporary `CODEX_HOME` so that the snapshot site is covered by a test rather
than by inspection.

Rows already stored as `unknown` are left alone. They are concentrated in the
`codex-mcp-client` label (3,145) that predates 0.9.31's originator-based
labelling, and the rollouts and sqlite files behind them are spread across
machines, so no single host can reconstruct them.

## 0.9.31 — 2026-11-02

### Platform labels come from `originator`, not the thread's `source` (#29)

`state_5.sqlite` records `source='vscode'` for the Codex desktop app, the CLI
(`codex-tui`) and ACP bridges alike, so every one of them was labelled
`codex-desktop` — or collapsed to `codex-mcp-client` when the `sqlite3` binary
was missing. The label now reads `threads.originator`, with `source` kept only
as a fallback, and the lookup uses `node:sqlite` (loaded lazily via
`createRequire`, so an older Node still starts) instead of shelling out.

Observed values are not spelled consistently — `codex-tui`, `codex_exec`,
`buzz-acp`, and `Codex Desktop` (capitalised, with a space). All four are
mapped explicitly. This matters beyond cosmetics: `search_memory` filters on
`agent_platform`, so a wrong label hides rows from a filtered query.

### Stuck envelopes report *which* rows are stuck (#30)

`buzz-ingest` counted un-cleaned envelopes by reason but never said which rows
they were, so "the count went up" could not be turned into a diagnosis. The
report now carries `envelopesStuckRows` (`{id, why}`) and
`envelopesStuckOmitted`, capped **per reason** — a global cap let the largest
reason crowd the others out of the sample entirely.

### History boundary: the closing tag that is followed by this turn (#31)

The envelope's history block (`<thread-context>` / `<conversation-context>`)
ended at the **first** closing tag. Discussing envelopes in a Buzz room puts
that literal tag inside a quoted message, so the boundary landed mid-history
and the whole envelope was stored unclean — the tagger then overflowed its
context and the embedding was computed from boilerplate.

The boundary is now the **earliest closing tag that is immediately followed by
a turn block**, and the decision lives in one place shared by cleaning, quote
reading and the embedding/display paths. Measured over all 1,945 envelopes that
have a history block, that single condition yields exactly one candidate on
every row. Requiring the tag to start its line, or rejecting candidates inside
a code fence, both looked equally good on production data and were both wrong:
the former breaks grok-cli's space-joined format (genuine boundary mid-line,
quoted one at line start — a shape with zero production rows but covered by a
synthetic test), and the latter cost 32 rows with no discriminating power.

Skipping a quoted tag moves the boundary later, which widens the dropped
region, so that case re-checks that no real turn block hides inside it. The
guard applies **only** when a candidate was skipped: applying it everywhere
made two rows embed their entire envelope (4,820 B → 53,191 B), a risk this
change did not introduce.

### The cold path only runs where it is turned on (#32)

`startColdPathWorker` compared `COLD_PATH_ENABLED === 'false'`, so an unset key
**enabled** it. The memory database lives on one machine, and the cold path
needs that database plus a local llama-server; every other install is meant to
be a thin client. But the published `.env.example` never mentioned the key, so
every machine that copied it came up with the cold path on, sharing one
Postgres advisory lock. No harm had occurred — the lock, not the design, is why
— and the lock is free for a moment on every restart of the real daemon.

The gate is now opt-in: only `"true"` (case- and whitespace-tolerant, because a
silent *off* on the one machine that must be on is the worse failure) turns it
on, the disabled log line prints the actual value including `(unset)`, and
`.env.example` ships the key set to `false` with the reason. The dedicated
daemon sets it internally and is unaffected.

## 0.9.30 — 2026-10-31

### Codex capture: stop discarding user text, and unblock the envelope re-clean (#28)

#### Fragments are no longer thrown away (`codex_capture.ts`)

Codex hands the prompt to us as a `content[]` array — platform manual, agent
instructions, core memory, room context, then the turn itself. The parser kept
only the **last** element, on the assumption that the last fragment is always
the real input. It usually is. But when someone pastes something *before* their
question, that paste is a separate fragment and it was silently dropped:

    ["<invoice><amount>100</amount></invoice>", "What's the amount in this XML?"]
    → stored: "What's the amount in this XML?"      (the XML is gone)

The shape of a fragment is not evidence of where it came from. Two attempts to
filter by shape were both defeated by counterexamples — one deleted user-pasted
XML, the other missed non-ASCII tag names entirely. So the capture no longer
drops fragments at all. Envelope removal is left to `cleanBuzzEnvelope`, which
only strips what it can confirm by grammar (`Scope:` plus `Channel: … (#uuid)`),
so hand-written `<invoice>` or `<새것>` are structurally out of its reach.

`message` now holds every fragment, `raw_message` keeps the pre-filter original,
and the room (`venue`) is still read from the whole fragment set because
`<context>` sits outside the body.

#### A caller's original is no longer silently overwritten (`hot_path.ts`)

`raw_message` was chosen as `cleaned !== null ? message : params.raw_message`.
When envelope cleaning succeeded, an original passed in by the caller was
dropped and the *cleaning input* was recorded as the original instead. For a
caller that deliberately separates the two — body in `message`, untouched
fragments in `raw_message` — that is data loss. The expression is now
`chooseRawMessage()`: an explicitly supplied original always wins.

#### Rows that already had a `raw_message` can be re-cleaned (`buzz_ingest.ts`)

Three call sites selected candidates with `raw_message IS NULL`. Because the
capture change fills `raw_message` on every Codex row, those rows could never
enter the re-clean path again — the fix above would have closed the one route
that removes repeated history from `message`.

That single condition was doing two jobs, so it is replaced by two:
preservation via `SET raw_message = coalesce(raw_message, $3)` (an existing
original is never overwritten), and idempotence via the candidate-collection
skip plus `AND $2 <> message`. Concurrent-modification safety compares both
`message` and `raw_message` (NULL-safe) and re-checks `is_active` and
`NOT is_pinned` inside the `UPDATE`.

#### Known limits

- **Not "zero loss."** When two records carry the same body but differ only in
  fragment order or whitespace, the stored `raw_message` is whichever arrived
  first. Test `⑤-4` pins that behaviour as a characterization test — it must be
  changed when the limit is fixed, not treated as a passing requirement.
- The existing injected-text filter still cannot fully separate a user's quotation
  from genuine injected instructions.
- Re-clean progress is bounded by whether the quoted originals were captured. On
  the production database at release time, 26 candidates had no origin row and 15
  had an origin whose text differed.


## 0.9.29 — 2026-10-05

### Buzz envelopes: cleaner embeddings, folded search results, no false "format changed" alerts

#### Embedding input (#16–#19)

Short Buzz turns ended up with almost the same vector, so unrelated searches
pulled up a cluster of them. The embedding input still carried the
envelope's wrapper tags (`<buzz-event …>`), the `Channel:`/`From:`/`Content:`
labels, and in some shapes the whole envelope.

- `buzzEmbeddingText` drops wrapper lines and the repeated labels and keeps
  the values. The briefing preview already did this; the embedding path did
  not. For rows under 200 characters this removes about half of the input.
- Envelopes that start with a turn block instead of `<context>` (218 rows)
  and manual (`<base>`) envelopes (2 rows) are stripped too. Before, they
  were embedded whole.
- A line that is only an identifier once its label is gone (channel uuid,
  `npub1…`, 64-hex) is dropped.
- A `Parsed:` tail is recognised by "its first key has a hex value", not by
  key name. Thread replies (`parent=…, root=…`) and bare-hex
  `mentions=[…]` are removed as well.
- The stored `message` is unchanged. Only the embedding input changes.

#### Search results (#16)

- `search_memory` folds the `<context>` block (room metadata) out of Buzz
  results; the `venue` and `p_tag` fields already carry it. Stored rows are
  not modified. In two test queries this block was 48% and 59% of the
  returned text.

#### Envelope cleaner (#20)

When agents discussed the envelope work in Buzz and pasted examples such as
`<buzz-event …>`, the next turn quoted those posts in its history block. The
cleaner's safety check then refused the whole turn, and the Buzz watcher
reported that the envelope format seemed to have changed (the 10-05 alert
covered 12 rows). The format had not changed.

- Inside the history block only, a turn tag counts as a mention when the
  block parses as `[n]` quote entries and no line consists of a turn tag
  alone. Every real turn opening checked (1,125) is such a line, so a broken
  envelope whose history never closes is still refused.
- Checked against every envelope row (2,524 old/new comparisons): no change
  except 10 previously refused rows that now clean. Two rows quote a line
  identical to a real turn opening and stay refused on purpose.
- The original text is still kept in `raw_message` on every path.

No migration. On hosts that run Buzz agents, updating gives folded search
results and lets the save-time cleaner handle `<base>` envelopes like
these. Until then, Mortar's ingest heals them within 5 minutes.

## 0.9.28 — 2026-10-04

### Registry retro-tagging uses registry names only, not their aliases

In 0.9.27 the promoter retro-tagged untagged memories whose d_tag matched a
registry name *or any alias of one*. An alias means "this old tag was merged
into that project", not "every mention of this word belongs to that project".
A memory the tagger deliberately left untagged, for example work on an
Android proxy phone, got `pacefy` ten minutes later because its d_tag was
`android`.

- Registry retro-tagging now matches registry names only.
- Aliases are still used to resolve the tagger's answer and to show old tagged
  memories under their project.
- Rows already retro-tagged through an alias are left as they are. All 14 from
  the first 0.9.27 run were checked by hand and are correct.

## 0.9.27 — 2026-10-04

### Project registry: the tagger picks from a short, human-chosen list

The tagger only ever saw the 20 oldest project tags (`TAGGER_CANDIDATE_STRATEGY`
defaults to `oldest` with a limit of 20). All 20 came from the first import on
04-29, so projects created after that (`marketadmin`, `pacefy`, `buzz`,
`youtube-channel-analyzer`, …) were never offered as choices, and the list
mixed generic words and version names (`dev-environment`, `opus-4.7`,
`project-v0.5.3`). Design: DEVLOG §24.

- `project_tags` gets `kind` (`project` or `category`; NULL = not in the
  registry) and `paused` (migration 031). A tag that is an alias is never a
  registry member.
- Registry mode turns on as soon as one registry member exists:
  - The tagger is offered every registry tag with its description. On a local
    model the output schema only allows a registry name or null. Any answer
    is still checked: only a registry tag or an alias of one is accepted.
    Anything else, including old tags that still exist, leaves `p_tag` NULL,
    and `NEW:<name>` creates nothing.
  - The d_tag promoter makes no new suggestions. Every run it retro-tags
    untagged memories whose d_tag equals a registry name or an alias of one,
    regardless of how often the name is used. (0.9.28: registry names only.)
  - The startup brief's active projects list shows only registry projects that
    are not paused.
  - `confirm_new_tag` and `apply_recommendations` add the confirmed name to the
    registry, without a description. When the registry is empty they do not,
    because one confirm would otherwise turn registry mode on with a single
    candidate.
- The old behavior applies only when the registry is empty or the `kind`
  column does not exist (before migration 031). Other database errors are
  thrown, so the caller retries; a temporary error no longer switches modes.
  Turning the registry off is a data change, not a release: unregister the
  entries and the old behavior returns within the 5-minute candidate cache.
- `manage_project_tags` gains:
  - `list_registry`. An entry that has become an alias is flagged.
  - `register_project`: tag and a one-line description (≤200 characters) are
    required; kind and paused are optional. When an entry is updated, a kind or
    paused value that is not given stays as it was. Alias tags are refused.
    Registering closes a pending new-tag suggestion with the same name.
  - `unregister_project`.
- `set_alias` and `confirm_alias` refuse a registry entry as the source, which
  would drop it from the registry without notice.
- `npm run check:registry` tests the rules (`src/cold_path/project_registry.ts`).

Run `mcp-agents-memory migrate` before starting this version.

## 0.9.26 — 2026-10-04

### Rejected names no longer take up the promoter's candidate slots

The promoter looks at the 50 most frequent d_tags, and it removed rejected
names only after taking those 50. A rejected name kept its slot while it stayed
frequent, so each rejection left one fewer slot for a new name. After the
first round of rejections all 50 slots were taken: 42 existing project tags and
8 rejected names, with no room for anything new.

- Rejected names are now removed before the top 50 are taken. Existing project
  tags stay in, because they are still used to tag memories carrying the
  same-named d_tag.
- `blocked` in the run log now counts only names that were confirmed or
  superseded and whose tag is gone, or names rejected during the run. Rejected
  names are no longer counted on every run.

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
  recommendation from the model: `project`, `generic` or `unsure`. The model is
  told never to call a proper name `generic`. On 70 real tag names (local
  Qwen3-14B) it rated all five known projects `project`, product and service
  names (`cafe24`, `smartstore`, `buzz`) `unsure`, and no real project
  `generic`.
- The promoter creates no project tag and tags nothing for a new name until a
  person confirms. Confirming creates the tag and tags the untagged memories
  that carry that exact d_tag.
- The clustering step is gone. The promoter looks at each frequent d_tag on its
  own: the threshold and the count it shows are that d_tag's own uses in the
  window. Clustering summed similar d_tags and also tagged memories carrying any
  of them; the groups were often wrong, and the summed count did not match what
  a confirm would tag. Tags that already exist are now applied only to
  memories carrying the same-named d_tag.
- If the model call fails or returns something unexpected, the name is not
  stored that run and is tried again on the next one (`deferred` in the log).
  The classifier asks for JSON in the prompt and sends `responseFormat: 'json'`,
  so it works with the default xAI provider as well as a local model.
- A name the person rejected is never suggested again, and the promoter does not
  tag memories with it even if such a tag exists. Rejection blocks only that
  exact name. Names that were confirmed, or that became tags some other way
  while pending (`superseded`), are not suggested again either.
- The tagger no longer creates a tag through `NEW:<name>` when that name is
  waiting for the person or was rejected; the memory gets no project tag
  instead. Other `NEW:` names are still created as before.
- `manage_project_tags` gains `list_new_tags`, `confirm_new_tag`,
  `reject_new_tag` and `apply_recommendations`. The last one takes the
  suggestion ids the user was shown and confirms `project`, rejects `generic`,
  and leaves `unsure` pending. Suggestions created after the user looked are not
  touched. If one id fails, the others still go through and the result lists
  the failed ids.
- The startup brief lists up to two pending suggestions that are not rated
  `generic` (`project` first) under "Project Tag Suggestions". If migration 030
  has not run yet, the brief leaves them out instead of failing.
- The run log line is now `suggested / refreshed / blocked / deferred /
  superseded / retrotagged`.
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
