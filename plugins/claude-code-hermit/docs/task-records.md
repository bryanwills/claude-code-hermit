# Task records

A commitment lives in `.claude-code-hermit/tasks/T-YYYYMMDD-HHMMSS[-x].md`. `scripts/task.ts` is the only writer. The record has a title, requester, definition of done (`summary`), owner, due date, conversation and optional approver. Status is `open` or `closed`; a closed record names its actor and `closed_by`: `check`, `confirmed` or `cancelled`. Passing time never closes a record.

## Record and CLI

Frontmatter contains scalars and flow arrays, with nullable fields set to `null`. Older records gain missing nullable fields on decode. The body contains Progress, Decisions, Approvals, Outcome and Lessons. Appending through the writer creates a missing section. Free text is normalized by the record codec.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts <verb> .claude-code-hermit ...`. State targets are pinned to the current project; writes are locked and atomic. Contract violations exit 2 with stable error codes.

| Verb | Contract |
| --- | --- |
| `open` | Requires `--title`, `--requester`, `--done`. Optional `--owner`, `--conversation`, `--card`, `--approver`, `--due`, `--claim`, `--dedupe-key`, `--check`. A matching open dedupe key returns the existing record. |
| `note <id>` | Appends stdin to Progress. Metadata flags include `--due`, `--card`, `--done`, `--check`, `--clear-waiting`; `--decision` and `--approval` target their sections. A changed definition of done bumps `result_rev` and clears the result. |
| `lesson <id>` | Appends stdin under Lessons. |
| `block <id>` | Records `--waiting-on` with `--status-line` and `--next`, or posts a result with `--result-stdin`. A posted result increments `result_rev` and stays open as unconfirmed. |
| `close <id>` | Confirmation requires an authorized actor, matching result revision and any named approver. Check closure requires verified evidence from a held claim or the matching duty. |
| `cancel <id>` | Requires actor and reason on stdin. Cancellation is separate from successful completion. |
| `list` | Supports `--open`, `--all`, `--owner`, `--conversation`, `--requester`, `--handle`, `--id`, `--dedupe-key`, `--with-check`, `--limit` (default 20), `--json`. JSON includes owner, result, waiting_on, closed_by and check. |
| `standup` | Reports windowed costs and commitments by person, with closed records grouped by closure actor type. Supports `--days` and `--json`. |
| `check-snapshot <id>` | Returns check, result revision and status for the gated runner. |

A runnable record is open, resident-owned, without a result or waiting dependency. It is labelled queued only if an earlier runnable record exists. Close and cancel return `next_queued: {id, handle, title} | null`; continue with that record in the same turn. Heartbeat nudges a runnable record after `tasks.queue_nudge_minutes` (default 60). Its acknowledgement token hashes id, opened time and result revision; changing the record invalidates an old acknowledgement.

## Evidence commands

`bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>` snapshots an open record with a result and check, scans the command for injection, then runs it from the project root with a 30-second default timeout and bounded output. It never holds the task lock across the subprocess. The internal result mutation rechecks command, status and result revision under the lock. Changed evidence returns `stale-check`. Exit 0 closes by `check`, actor `hermit`, reason `check:exit-0`; other exits append progress.

The result mutation is not exposed by the pre-approved task CLI. The command runner has no permission allow-list entry. The daily later check lists open records with checks and results and invokes the gated runner.

## Execution and context boundary

`state/execution.json` records `in_flight`, `idle` or `unknown`, with observation time and Claude session identity. Prompt admission marks a resident turn in flight; Stop and StopFailure mark idle; boot and compaction mark unknown. Stale in-flight observations become unknown. Guests do not write this state.

The safe boundary requires idle for at least 60 seconds, an identity matching runtime `cc_session_id`, no running helper conversation, and an idle or shell registry entry when the resident PID has one. A configured token floor must also be met. Unknown never becomes idle through registry fallback. List and standup can display `execution: unknown (registry: <status>[, <waitingFor>], live process)` to explain an unknown observation.

The standalone watchdog clear additionally requires an unchanged pane across two ticks and operator quiet, context age or changed policy. Defaults are one quiet hour, maximum age 24 hours and 20,000 compactible tokens. Policy hashes cover OPERATOR.md, TASKS.md, CLAUDE.local.md, settings and configuration, excluding machine-maintained channel routing and version keys. Clears are locked and deduplicated per reset. Monitor rearming uses the same safe execution boundary.

## Cost and readers

Progress-bearing writes bind task ids to the current turn. Matching cost rows carry `bucket: tasks`; shared rows allocate cost and tokens equally across their task ids. Otherwise channel conversation work is `conversation`, while heartbeat and routine work is `duties`. Helpers match their conversation task. The version-4 cost index stores date-keyed `by_task` buckets for 90 days; wider windows fall back to a scan using the same allocator. This is attribution, not a separate provider bill.

`scripts/lib/task-report.ts` normalizes records for brief, reflect, weekly review, cost report, health, MCP, export and dashboard. `done` means check or confirmed, `cancelled` remains distinct, and a result on an open record is `unconfirmed`. Lessons come from the record body. Readers use task records only. Recall also searches retained historical archives.

SessionStart injects TASKS.md beside operator policy, with a pointer after compaction. Duty summaries combine requested schedules and effective heartbeat mode with observed liveness and verdicts. Effective forced mode applies only to the boot that issued it.

## Channel workflow

Before replying, the responder lists open records for the conversation and records operator activity. TASKS.md decides whether an assignment needs a record. In a guild channel, a resident task may receive its own thread and card without a helper conversation binding. Replies in an open resident-owned thread reach the resident; authorization still applies, unrelated passive chatter remains blocked and helper bindings take precedence.

A confirmed result closes only the matching revision. Any authorized human in the conversation can steer a record; a named approver restricts confirmation. Duties may open deduplicated records for work requiring a person when `tasks.duties_open_records` is enabled.
