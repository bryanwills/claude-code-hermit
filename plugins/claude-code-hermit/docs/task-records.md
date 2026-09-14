### 1.1 Record

Path `.claude-code-hermit/tasks/T-YYYYMMDD-HHMMSS[-x].md`, UTC timestamp at open, `-x` a 1-char base36 suffix only on collision. Markdown with YAML frontmatter restricted to what the generic parser round-trips (`scripts/lib/frontmatter.ts:36-62` → `_parseFrontmatterWithEnd`: scalars, `null`, flow arrays of scalars; serializer `scripts/lib/md-write.ts:26-32` → `serializeValue`). No nested objects, no arrays of objects. Free-text strings: the generic parser strips the outer quotes of a JSON-quoted scalar but does not unescape it (a `"` or `\` inside reads back escaped), so the codec writes every string through `serializeValue` with newlines collapsed to spaces, and on read JSON-parses any raw scalar value that is fully double-quoted itself; flow-array items (`tags`, `claims`) are validated slugs with no quotes or commas. `frontmatter.ts` stays untouched; recall's title display may show the escapes (stated limitation). `scripts/lib/tasks.ts` owns a validated codec on top of that parser (closed sets, id regex `^T-\d{8}-\d{6}(-[a-z0-9])?$`, required keys) and rejects a malformed record with a stable error.

Frontmatter (every key always present; `null` where unset):

| Key | Type | Written by | Notes |
|---|---|---|---|
| `id` | `T-…` | open | immutable |
| `type` | `task` | open | `scripts/lib/search.ts:222` labels it |
| `title` | string | open | |
| `created` | ISO | open | equals `opened_at`; `extractDate` (`search.ts:46-51`) reads `created`, not `opened_at` |
| `summary` | string | open, note `--done` | the definition of done; `fmText` (`search.ts:~205`) scores `title`, `tags`, `summary`, `task` |
| `tags` | `[task, <requester>]` | open | flow array of strings |
| `audience` | `<conversation key>` \| `operator` | open | `audienceVisible` (`scripts/lib/channel-auth.ts:130-142`): own chat sees it when scoped; `operator` (no colon) is hidden from every scoped recall; a channel with `isolate_chats: false` or `shared_chats` sees other chats' records by that channel's existing policy (`:121-127`) |
| `status` | `open` \| `closed` | open, close, cancel | closed set |
| `opened_at`, `closed_at` | ISO \| null | | |
| `closed_by` | `check` \| `confirmed` \| `cancelled` \| null | close, cancel | closed set; never `auto`; written in exactly one function |
| `closed_actor` | string \| null | close, cancel | `hermit` or `duty:<name>` for `check`; channel identity otherwise |
| `closed_reason` | string \| null | close, cancel | words for `confirmed`, reason for `cancelled`, evidence source for `check` |
| `requester` | `<sourceKey>:<user_id>` \| `duty:<name>` \| `proposal:<id>` \| `operator` | open | from the parsed envelope (`scripts/lib/channel-envelope.ts:13-30` → `ChannelEnvelope`: `userId` preferred over `userName`) |
| `requester_name` | string \| null | open | display only |
| `origin_message_id` | string \| null | open | envelope `messageId`; provenance |
| `approver` | string \| null | open | explicitly named approver; when set, `confirmed` requires this actor and results wait on this actor |
| `due` | ISO \| null | open, note `--due` | |
| `conversation` | `<sourceKey>:<chat_id>` \| null | open | routing key, same shape as `checkKey` accepts (`scripts/lib/conversations.ts:46-48`) |
| `card_chat_id`, `card_message_id` | string \| null | open, note `--card` | resident-owned tasks only. Helper-owned tasks keep both null: their card lives in `conversations.json` (`scripts/lib/conversations.ts:12`, sole writer `scripts/conversation.ts:117-120`) and is resolved through `conversation`. One owner per field |
| `handle` | string | open | short slug from the title, unique among open tasks |
| `owner` | `resident` \| `helper:<conversation key>` | open | execution owner |
| `waiting_on` | string \| null | block, note `--clear-waiting` | |
| `waiting_since` | ISO \| null | block | |
| `result` | string \| null | block `--result-stdin` | the posted outcome line; open with `result` set lists as `unconfirmed` |
| `result_rev` | int | block `--result-stdin` (+1), note `--done` (+1, clears `result`) | the revision a confirmation must name |
| `result_at` | ISO \| null | block | |
| `stall_at`, `stall_status`, `stall_next` | ISO/string \| null | block without result | the one message posted to the requester |
| `dedupe_key` | string \| null | open | `duty:<name>:<item>` |
| `claims` | string[] | open `--claim` | `later` claim ids; `check` closure reads their verdict |

Body sections, one line each, appended by scripts: `## Progress` (`- <ISO> <actor>: <line>`), `## Decisions` (`- <ISO> <actor>: <what>`), `## Approvals` (`- <ISO> <actor>: <what>`), `## Outcome`. Minimal references only; proof and interactions stay in chat.

Derived listing labels (never stored): `late` (open, `due` < now), `unconfirmed` (open, `result` set), `waiting on <x>` (open, `waiting_on` set, no `result`), `queued` (open, `owner = resident`, an earlier-opened resident task is open without a result), `shared` (a cost row lists more than one task).

### 1.2 Verbs (`scripts/task.ts <verb> <hermitDir> …`)

Every invocation first pins the state root (`scripts/lib/cc-compat.ts:210` → `pinStateDirOrExit`, used by `scripts/conversation.ts:28`; `docs/security.md` § Script Argument Trust) and validates ids against the regex. `scripts/later.ts:124-127` (`path.resolve(dirArg)`, unpinned) is the anti-pattern. All writes go through one locked atomic writer in `scripts/lib/tasks.ts` (pattern `scripts/lib/conversations.ts:21-38` → `withStore`). Every verb prints a one-line JSON digest and exits 0; contract violations exit 2 with a stable error code. Progress-bearing verbs (`open`, `note` with a line, `block`, `close`, `cancel`) record the turn binding (§1.4); metadata-only flags do not.

| Verb | Required | Optional | Digest | Errors |
|---|---|---|---|---|
| `open` | `--title`, `--requester`, `--done` | `--requester-name`, `--origin-message-id`, `--due`, `--conversation`, `--card '{chat_id,message_id}'` (resident only), `--owner`, `--approver`, `--dedupe-key`, `--claim` (repeatable) | `{id, handle, created: true\|false, open_count, queued: bool}` | `invalid-requester`, `invalid-conversation`, `invalid-owner`, `card-on-helper-task` |
| `note <id>` | stdin line (may be empty only with a metadata flag) | `--actor`, `--due`, `--card`, `--decision`, `--approval "<actor>: <what>"`, `--done "<new definition>"` (decision line with actor, sets `summary`, bumps `result_rev`, clears `result`), `--clear-waiting` | `{id, result_rev}` | `not-open`, `empty` |
| `block <id>` | `--waiting-on` or `--result-stdin` | with `--result-stdin`: `waiting_on` defaults to `approver ?? requester`, `result_rev` +1; without a result: both `--status-line` and `--next` | with result: `{id, listing: "unconfirmed", result_rev, waiting_on}`; stall: `{id, post_to: {conversation, requester}, status_line, next_step}` | `not-open`, `stall-needs-status-and-next` |
| `close <id>` | `--by check\|confirmed`, `--actor` | `confirmed`: `--result-rev N` (must equal current), `--reason-stdin`; `check`: `--claim <id>` whose `later` verdict is `held`, or `--actor duty:<name>` on a record whose `dedupe_key` names that duty | `{id, closed_by, result_rev}` | `not-open`, `invalid-closed-by`, `approver-required`, `stale-result` (rev mismatch or no result), `check-needs-evidence` |
| `cancel <id>` | `--actor`, `--reason-stdin` | | `{id, closed_by: "cancelled"}` | `not-open`, `empty-reason` |
| `list` | | `--open` (default), `--all`, `--conversation <key>`, `--requester`, `--handle <h>`, `--id <id>`, `--dedupe-key`, `--json` | at most 20 rows `id handle listing requester title due result_rev` plus `total` and `omitted`; an exact `--handle`/`--id` match is always returned even beyond the cap; plus one `execution:` line (§1.3) | |
| `standup` | | `--json`, `--days N` | by person (stable identity, display name beside it): promised (open, any owner), late, waiting on them (`waiting_on` = that person); rows `id handle title due cost_usd`, sorted by lateness within person; per-task cost is a full scan of the cost log by `task_id` (same scan as `scripts/lib/session-cost.ts:13-30` → `sumWindow`) | |

`check` evidence via `later`: `close --by check --claim <id>` reads that claim's row from `later`'s ledger (`state/hypotheses.jsonl`, `scripts/later.ts:128`) read-only, by exact id; `later.ts` is not modified and stays the ledger's sole writer (`later.ts list` caps settled claims at 10, so it cannot serve as the evidence path). Free-text definitions of done with no claim and no duty close only by `confirmed`.

Invariants (each has a behavioral test): no verb path closes without `close`/`cancel`; `closed_by` is in the closed set; `confirmed` honors `approver` and `result_rev`; `check` needs a held claim or a duty resolution; `block` without a result needs both stall fields; `open` with a matching open `dedupe_key` creates nothing and replays return the existing digest; two concurrent `open`s produce two distinct ids; `list` never hides an exact match; `task.ts` never writes `runtime.json`, `SHELL.md`, `sessions/`, `conversations.json`, `hypotheses.jsonl`; a foreign `hermitDir` argument exits before any read.

Shared control: `close --by confirmed`, `cancel`, and `note --done` accept any authorized human in the task's conversation; the skill passes that human's channel identity as `--actor`. A named `approver` is the one exception and applies only to `confirmed`. Authorization is the existing channel allowlist and resident gate (`scripts/user-prompt-pipeline.ts:126-134`); no owner list.

### 1.3 Execution observation (harness-derived, advisory, resident-only)

File `state/execution.json`: `{state: "in_flight"|"idle"|"unknown", turn_id, at, source, cc_session_id, reason}`. `turn_id` is informational; nothing gates on it.

| Event | Script and anchor | Write |
|---|---|---|
| Prompt admitted | `scripts/user-prompt-pipeline.ts:198` → `emit()`, after the `blockReason` early return, beside `openTurnMarker()`. Gated by a new module-level `residentAdmitted = !guest` set at `:124` (where `guest` is computed), not by `operatorActivityKept` (operator prompts only, `scripts/record-operator-action.ts:179`) | `in_flight`, fresh `turn_id`, `source` from `scripts/lib/trigger-source.ts:62` → `classifySource` |
| Prompt blocked | any `block` stage | nothing |
| Guest session | `:124`, `:155` | nothing at UserPromptSubmit, Stop, StopFailure, SessionStart or PreCompact |
| Stop | `scripts/stop-pipeline.ts:56-57`, before the stages, beside the marker unlink, inside the resident branch (`:48`) | `idle`, `last_turn_id` |
| StopFailure | `scripts/stop-failure-stamp.ts:50-54`, after the guest gate at `:36` | `idle`, `reason: "stop-failure"` |
| SessionStart (any source) | `scripts/startup-context.ts`, resident path only (after `residentSessionActive`; `scripts/lib/guest-marker.ts:5-14`) | `unknown`, `reason: "session-start:<source>"` |
| PreCompact | `scripts/precompact-stamp.ts`, guest-gated like `stop-failure-stamp.ts:36` | `unknown`, `reason: "precompact"` |
| Reader sees `in_flight` older than 60 min | `lib/tasks.ts` → `readExecution` | reports `unknown` |

No new hook events. `state/operator-turn-open.json` keeps its exact contract. All reads of `execution.json` and `task-turn.json` fail open on ENOENT or bad JSON (pattern `scripts/lib/frontmatter.ts:151-164` → `globDirRecursive`). Nothing acts on the observation except `task.ts list`/`standup` display.

### 1.4 Cost attribution

Row fields added in `scripts/lib/cost-log.ts:417-441` → `buildMainCostRow` and `:443-463` → `buildSubagentCostRow`: `task_id: string|null`, `task_ids?: string[]` (when more than one), `bucket: "tasks"|"conversation"|"duties"`, `attribution: "binding"|"helper-conversation"|"dispatch"|"source"`. `SOURCE_ATTRIBUTION_VERSION` (`cost-log.ts:42`) stays 2. A row without `bucket` is pre-upgrade: readers count it as `conversation` and `standup` shows it as "pre-upgrade".

Turn binding file `state/task-turn.json`: `{cc_session_id, task_ids: [first…], at, turn_id}`. The first progress-bearing `task.ts` call in a turn creates it with the resident's `cc_session_id` (from `execution.json`); later calls append. Consumed by exactly one logged Stop.

Match rule at `scripts/cost-tracker.ts:870` (row build, beside `:128` → `resolveTurnSource`), the same session-plus-recency pattern as the dedupe guard (`cost-tracker.ts:807-825` → `lastLoggedMainRow`):

1. `state/task-turn.json` exists, its `cc_session_id` equals this Stop's `cc_session_id` (`cost-tracker.ts:876`, `ccSessionId: sessionId`; guests run cost-tracker too, `stop-pipeline.ts:71-75` before the guest return at `:124`, so the session check keeps a guest Stop from consuming a resident binding), and `binding.at` is newer than the last logged main row's `observed_at` → `bucket: tasks`, `task_id: task_ids[0]`, `attribution: binding`; delete the file on the path that appends a row. A deduplicated Stop (`:821-825` returns before `:870`) leaves it for the next logged Stop. A binding older than 60 min is ignored and deleted.
2. Else this `cc_session_id` equals a `conversations.json` entry's `session_id` (`scripts/lib/conversations.ts:7-17` → `Conversation`; stored from `claude agents --json` `sessionId`, `skills/spawn-session/SKILL.md:107`) and a task has `owner = helper:<that key>`: the open one, else the most recently closed by `closed_at` → `tasks`, `attribution: helper-conversation` (helper worktrees resolve state to the main hermit dir, `scripts/lib/cc-compat.ts:46-52` → `hermitDir()`).
3. Else `source` is `heartbeat` or `routine:*` → `duties`, `attribution: source`.
4. Else → `conversation`, `attribution: source` (`other`, `channel:*`, `peer`).

Allocation policy (in `docs/task-records.md`, shown in `standup` as `shared`): a turn that touched more than one task bills whole to the first task bound in it and lists the rest in `task_ids`. No fractional split. Not exact provider cost, and a missed `note` bills a task turn to `conversation`.

Subagent rows built in the same Stop (`cost-tracker.ts:926` → `appendCostRows(COST_LOG, [logEntry, ...subagentRows])`) copy the main row's `task_id`/`bucket`. Async subagent rows (`scripts/subagent-cost.ts:156` → `buildSubagentCostRow`): `:85` → `findAsyncLaunch` locates the launch entry and `:132` → `resolveTurnSource` walks to the dispatching turn's boundary; the row inherits `task_id`/`bucket` from the main row logged for that dispatching turn (same `cc_session_id`, first main row whose `observed_at` is at or after that boundary timestamp), `attribution: dispatch`; if that turn is not logged yet, the current binding file is read without consuming it.

Non-atomicity: the task write, the binding write and `appendCostRows` (`scripts/lib/cost-log.ts:470-488`, no lock) are three operations. A crash between them leaves at worst a binding that the next logged Stop of the same session consumes within 60 min or drops; a row is never written twice for the same turn (existing dedupe guard). StopFailure turns run no cost-tracker (`stop-failure-stamp.ts:8-11`); unchanged.

Sum rule: for any window, rows partition into the three buckets and their sum equals the log total. Ownership tests assert the expected `task_id` per fixture and the `unknown` cases.

### 1.5 Duties

No new store. `scripts/duties.ts list [--json]` derives `last_run` and `last_verdict` per duty: routines from `scripts/lib/routines/history.ts:312-330` → `lastRoutineFire` / `lastRoutineEvent` (the event writer already suppresses replayed `fired`, `scripts/lib/routines/event.ts:92`); heartbeat from `state/alert-state.json` (`scripts/lib/alert-state.ts:29-49`: `total_ticks`, per-alert state, `last_clean_eval_at`) with verdict `ok`, `findings:<n>` or `frozen` (ambiguous read); watches from `state/monitors.runtime.json` (session-scoped, `skills/watch/SKILL.md:29-49`), labeled "since session start". The only new write is `scripts/duties.ts record watch <id> --verdict <v>`, which updates that watch's entry in `monitors.runtime.json` (`last_event_at`, `last_verdict`), called from `skills/watch/SKILL.md` when a watch event is handled. `duties.ts` is pinned like `task.ts`.

Duty records: a duty opens a record only when a human must act: `requester: duty:<name>`, `waiting_on`, `due`, `dedupe_key: duty:<name>:<item>` where `<item>` is the heartbeat item key from `scripts/lib/heartbeat-items.ts:39-50` → `normalizeItemKey` or the watch id plus event key. `open` returns the existing open record (`created:false`) so the duty does not repeat; the existing alert ladder keeps owning notification suppression (`scripts/lib/heartbeat/alert-update.ts:194-217,303-306`). When the ladder resolves the item, the heartbeat skill calls `close --by check --actor duty:heartbeat` on the record with that `dedupe_key`; an ambiguous read never closes anything. `config.tasks.duties_open_records: false` makes the heartbeat and watch skills post plain messages instead (policy; the script does not enforce it).

Trust word per heartbeat item: a trailing token `[ask]`, `[act]` or `[note]` at the end of the item line (default `ask`). Trailing keeps `normalizeItemKey` stable (first eight normalized characters); a leading word would rename every item's alert history. `state-templates/HEARTBEAT.md.template:2` gains one comment line explaining it.

Bookkeeping one-liners are a ledger duty described in `TASKS.md`, not records.

### 1.6 Channel-responder and helpers

Precedence: a new short rule placed after the Micro-approval response branch (`skills/channel-responder/SKILL.md:197-223`) and before the state check §1b (`:64-89`, which stays). A bare "yes"/"ok"/"no" with a pending micro-proposal is a micro-proposal answer, as today. Otherwise run `task.ts list --open --conversation <sourceKey>:<chat_id>`. A message replies to an open task when the chat is a Discord thread bound to it, when the text carries an open handle, or when exactly one task is open in that conversation and the message continues it. Two or more open, no handle, no thread: one short question naming the handles, nothing recorded. Confirmation words (per `TASKS.md`) on a task whose `result` is set → `close --by confirmed --actor <sourceKey>:<user_id> --result-rev <current>`; cancel words → `cancel`; a changed definition of done → `note --done`; steering → `note`. A plain question opens nothing. No reply-parent or reaction metadata exists in the official plugins; nothing depends on it.

Bind branch (`:185-190`): after `update '<key>' --card`, run `task.ts open --owner helper:<key> --conversation <key> --requester <sourceKey>:<user_id> --origin-message-id <message_id> --title … --done …` (no `--card`). Bound conversation branch (`:140-141`, forwards to an existing helper without re-running Bind): a forwarded message that is a new assignment also opens a record with `owner helper:<key>`; steering is `note`. Helper REPORT handling (`skills/watch/SKILL.md:207-210`, `Done:` edit at `:210`): after that edit, `task.ts block <id> --result-stdin`, or `close --by check --claim` when a linked claim is held. The helper never touches `tasks/` (`skills/spawn-session/SKILL.md:26-28,98`); the existing REPORT sender/generation validation stays the trust mechanism.

Task assignment branch (`:192-195`, idle only): keep the `session_state` gate and the `/claude-code-hermit:session-start` call; after the "On it" reply, `task.ts open --owner resident --conversation <sourceKey>:<chat_id> --card '{…}' --requester … --origin-message-id … --due …`. New instruction branch (`:229-234`, busy): a compatible instruction → `note` on the current task (plus the SHELL.md update it already does); a replacement → after the existing confirmation, `cancel` or `block` the old record and `open` the new one; an ask to do something after the current work → `task.ts open --owner resident` only, the digest returns `queued: true`, and the reply states the queue position. Pickup happens through the existing session workflow: the `session` skill reads `task.ts list` at close-out and offers the next queued record. No automatic draining.

Card milestone edits (`skills/session/SKILL.md:37`) pair with `task.ts note`; card close-out (`skills/session/SKILL.md:74`) pairs with `block --result-stdin` or `close --by check --claim`. Handle: shown in the card and replies only when two or more tasks are open in that conversation, and in a DM only when `config.tasks.handle_in_dm` is true.

Non-result stall: `block` without a result requires `--status-line` and `--next` and its digest names where to post; the skill posts that one message to the requester in the task's conversation. Contract; wording is policy.

### 1.7 Policy home: `TASKS.md`

`state-templates/TASKS.md.template` → `.claude-code-hermit/TASKS.md`, seeded absent-only by hatch (`scripts/hatch-scaffold.ts:108` → the `seedIfAbsent` call for HEARTBEAT.md is the sibling) and by evolve (Upgrade Instruction), never overwritten (`CLAUDE.md:64`). Sections: record threshold (default: work that outlasts the turn or needs a human), confirmation and cancel words, card / notice / standup wording, whether questions inside a task's place are logged (default: not unless they change the task), bookkeeping ledger duty description. `skills/task/SKILL.md` reads it first. Authorization, evidence, dedupe and transition validity stay in code.

### 1.8 Config, permissions, storage, startup, upgrade

- `config.tasks: { handle_in_dm: false, duties_open_records: true }` in `scripts/lib/config-read.ts:55-146` → `TABLE` (`shape({…})` like `heartbeat` at `:90-98`), `state-templates/config.json.template`, `scripts/validate-config.ts:115` → `validate()`, `docs/config-reference.md` (after `:390`).
- `state-templates/deny-patterns.json` (`deny` and `ask` arrays only): deny adds `Edit(*.claude-code-hermit/tasks/**)`; ask (`:46-52`) adds `Edit(*.claude-code-hermit/TASKS.md)`. Per-script allow entries: `scripts/apply-settings.ts:121` (`'Bash(bun */scripts/conversation.ts*)'` is the sibling) under the sealed `permissions-sync` op (`scripts/lib/settings/automode-entries.ts:20-27`): add `Bash(bun */scripts/task.ts*)` and `Bash(bun */scripts/duties.ts*)`. `docs/security.md:97-115` lists the rules; § Script Argument Trust names the two scripts as pinned.
- `scripts/lib/drift.ts:10-12` → `KNOWN_DIRS` gains `tasks`.
- `scripts/startup-context.ts:428` → `emitFullContext` gains one bounded section `Open tasks` after `Active Session` (at most five lines: count, then `id handle listing requester due`, within `HARD_CAP` at `:36`); `:405` → `emitCompactCapsule` gains one line with the count. Resident only.
- `scripts/lib/search.ts:174-180` (the `dirs` arrays): add `path.join(hermitDir, 'tasks')` to both branches; `audienceVisible` at `:191` scopes records via the `audience` key. Requester is not a scored field (stated limitation in the docs).
- `scripts/lib/dashboard.ts:302-313` → `loadDashboardState` gains `byPerson` from `lib/tasks.ts`; `:599-606` → `renderCoreSections` gains `byPerson`; `:626-631` body order puts it after `status`; escape names with the existing helper in `scripts/lib/artifact-strings.ts`. Custom renderers (`scripts/artifact.ts:33-38`) keep working; `tests/dashboard-custom-render.test.ts`'s exact key set gains `byPerson`.
- `CHANGELOG.md:3` `[Unreleased]`: `### Added` bullets in the terse style; `### Upgrade Instructions`: create `.claude-code-hermit/tasks/` if absent; seed `TASKS.md` from the template only if absent; nothing extra for config keys (finalizer, `skills/hermit-evolve/reference.md:112-129,313-327`) or permissions (permissions-sync). `plugin.json` stays 1.3.7.
- `docs/how-to-use.md:283-289` skills table gains `task`; README.md gets one sentence where chat task assignment is described.

