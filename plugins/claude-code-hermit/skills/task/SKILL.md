---
name: task
description: 'Track commitments, progress, results and confirmations beside sessions.'
---

# Tasks

Read `.claude-code-hermit/TASKS.md` first for record threshold, wording and confirmation policy. Use `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts <verb> .claude-code-hermit ...` for every record operation. Never edit `tasks/` directly. Consult `../../docs/task-records.md` for the command contract.

## Intake
Pending micro-proposal answers take precedence. Run `task.ts list .claude-code-hermit --open --conversation <sourceKey>:<chat_id>` before interpreting task steering. A bound thread, open handle, or continuation of the sole open task identifies the record. If multiple tasks are open without a handle or thread, ask one short question naming the handles. Plain questions create nothing.

Use `open --title ... --requester <sourceKey>:<user_id> --done ...` for assignments. Pass requester display name, origin message id, conversation, due date and explicitly named approver when available. Resident records may carry `--card`; helpers use `--owner helper:<conversation key>` and never own card fields or write records themselves. Resident readiness is handled by `/claude-code-hermit:resident-start`.

For work requested after the current work, open a resident record and state its queue position from the open-task ordering. After a close or cancel, continue with `next_queued` in the same turn when the digest names a record. Show the handle in cards and replies only when at least two tasks are open in that conversation; in DMs also require `config.tasks.handle_in_dm`.

## Progress and results
Pipe one progress line into `note <id>`, pairing it with milestone card edits. Metadata flags include `--due`, `--card`, `--clear-waiting`, `--decision`, and `--approval "<actor>: <what>"`. A changed definition uses `note <id> --done ... --actor <human identity>`: it increments result_rev and clears the old result.

Post an outcome through the originating channel's reply tool, then pipe that same outcome into `block <id> --result-stdin` before ending the turn. For terminal-origin work, post it in the terminal. Require `listing: "unconfirmed"` and a positive `result_rev` in the digest before claiming the result is recorded. Finished recommendations, drafts and reviews awaiting acceptance use this result form.

A stall in unfinished work requires `--waiting-on`, `--status-line` and `--next`; post the digest's one status/next-step message to its requester in its conversation. Those flags alone do not save an outcome. If a finished outcome produced a stall digest, run `block <id> --result-stdin` to record the result.

## Closure
Stored status is only `open` or `closed`; closed_by is only `check`, `confirmed`, `cancelled` or null. `close`, `cancel`, and a passing `task-check.ts` run close records. Never infer closure from harness idleness.

Use `close <id> --by confirmed --actor <sourceKey>:<user_id> --result-rev <current> --reason-stdin` for confirmation of a posted result. The revision must match and a named approver must be the actor. Any authorized human in the conversation may otherwise confirm, cancel, or change the definition of done. There is no owner list.

Use `close <id> --by check --actor hermit --claim <linked claim>` only when the later claim is held. A resolved duty uses its matching `duty:<name>` actor and dedupe key. Free-text proof alone cannot close a task. Use `cancel <id> --actor <human identity> --reason-stdin` with a nonempty reason to cancel.

## Standup and duties
`standup --json` groups promised, late and waiting work by stable identity. Execution is advisory. A shared turn divides its cost equally across its bound tasks; a missed progress note may bill to conversation. Older rows without buckets are pre-upgrade.

Duties open deduplicated records only when a human must act and `config.tasks.duties_open_records` permits it. Otherwise post plain messages. An ambiguous duty read never closes a record.

## Lessons and executable checks
Before closing, pipe any lesson into `task.ts lesson .claude-code-hermit <id>`. Omit this operation when there is no lesson.

Set a command with `open --check '<command>'` or `note <id> --check '<command>'`; `--check clear` removes it. Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>` to evaluate it from the project root, subject to the normal command permission gate. Exit 0 closes by `check`; a nonzero exit records progress. A changed command or definition of done invalidates a running check's revision.
