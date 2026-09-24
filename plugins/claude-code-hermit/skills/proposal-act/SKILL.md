---
name: proposal-act
description: 'Accept, defer, dismiss, or resolve a proposal. For accepted proposals, asks how to proceed: start implementing now, queue a task, or note for manual implementation. Activates on messages like "accept PROP-", "dismiss PROP-", "defer PROP-", "resolve PROP-".'
---
# Proposal Act

Take action on a proposal: accept, defer, dismiss, or resolve.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. On a channel-tagged turn, step 4's bounded ask (below) also queues a durable micro-proposal entry via `proposal.ts queue-micro` — see `channel-responder` § Channel-safe ask bridge — so it survives compaction or a session restart.

## Usage

```
/claude-code-hermit:proposal-act accept PROP-019
/claude-code-hermit:proposal-act defer PROP-015
/claude-code-hermit:proposal-act dismiss PROP-012
/claude-code-hermit:proposal-act resolve PROP-008
/claude-code-hermit:proposal-act accept PROP-019 --answer "queued task"
/claude-code-hermit:proposal-act accept PROP-019 --no-artifacts
```

The `--answer` form is not typed by an operator — it's how a channel-safe resolution re-enters step 4 after an out-of-band reply (see `branches.md` § Channel re-entry (`--answer`)).

**Options:** `--no-artifacts` (alias `--no-artifact`) skips the dashboard and proposals-page refreshes. Patch, events, replies, and the micro-proposal queue are unaffected.

Rare-branch procedures live in `${CLAUDE_PLUGIN_ROOT}/skills/proposal-act/branches.md`. "Read branches.md § X" means: read that section now and follow it exactly — it is normative.

If no action or ID is provided, ask the operator which proposal and action.

## Resolving a Proposal ID

Before reading any proposal file, resolve the operator's input to a filename:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts resolve-id .claude-code-hermit "<operator input>"
```
- `MATCH|<filename>` — proceed with that file.
- `NONE|not-a-prop-id` — error "Not a PROP id."
- `NONE|no-match` — error "No proposal matches [input]. Use /proposal-list to see available proposals."
- `AMBIGUOUS|<json array of {file, title}>` — show a disambiguation prompt:
  ```
  Multiple proposals match PROP-NNN:
    PROP-NNN-capability-brainstorm-103612 — [title of first match]
    PROP-NNN-session-cost-tracking-104207 — [title of second match]
  Reply with the full ID to continue.
  ```
  Re-resolve with the operator's reply.

## Timestamp Convention

All timestamps in frontmatter and Operator Decision text use ISO 8601 with timezone offset (e.g., `2026-04-06T14:30:00+01:00`). Use the timezone from `config.json` if set, otherwise UTC. `@now` in a `proposal.ts patch` `--set` value or in a stdin `Decision:`/`Set:` line expands to this stamp — prefer it over composing the timestamp yourself.

## Dashboard Refresh

Every flow below (accept, defer, dismiss, resolve) changes a proposal's status. After its final "Respond" step, refresh the dashboard and the proposals page (`config.artifacts.proposals`) per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` — both silently, no URL re-post (unlike `proposal-create`'s initial announcement, these status-change confirmations don't append the proposals-page URL). Skip both when `--no-artifacts` is set. When the accept flow resolves the proposal itself, the inner resolve is invoked with `--no-artifacts` and this outer flow still refreshes once at its end, so one operator turn publishes at most once per page.

## Accept Flow

When the operator accepts a proposal:

1. Resolve the proposal file using the resolution algorithm above, then read it.

2. **Determine what to set.** Use the current task record id when this turn belongs to an open record. From the file already read in step 1:
   - `responded`: if currently `false`, plan `--set responded=true` for the patch call below and fire the first-response event now, **before** that patch call, so its summary regen already reflects it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts event .claude-code-hermit responded --id=PROP-NNN --action=accept
     ```
     If `responded` is already `true`, skip both (prevents double-counting).
   - `accepted_in_session`: this retained provenance field takes the current task record id, when one exists, via `--set accepted_in_session=<task_id>`. Without a current record, leave it unset.
   - `success_signal` (optional): check whether the body has a `## Success Signal` section with a non-empty predicate line (ignore comment lines starting with `<!--`). If found, validate it:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts success-signal --validate "<predicate line>"
     ```
     Exit 0 → plan a stdin `Set: success_signal=<predicate line>` line for the patch call (free text — never argv `--set`). Exit non-zero → plan a `task.ts note .claude-code-hermit <id>` warning when running inside an open record, otherwise report the warning: `PROP-NNN success_signal ignored: <reason printed by the script>`. No section, or empty/comment-only → leave `success_signal` unset. Never block accept regardless of outcome.

3. **Patch.** One call applies the frontmatter flip, session tracking, success signal, and the Operator Decision timestamp — assembled from what step 2 determined:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .claude-code-hermit <filename> \
       --set status=accepted --set accepted_date=@now \
       [--set responded=true] [--set accepted_in_session=<task_id>] --stdin <<'HERMIT_PATCH'
   Decision: Accepted on @now.
   [Set: success_signal=<predicate line>]
   HERMIT_PATCH
   ```
   Do NOT set `resolved_date` — resolution happens when reflect confirms the pattern is gone. `OK|<id>` confirms the write; `ERROR|<reason>` means nothing was patched — report it to the caller/operator and stop.

3a. **Routine proposals.** If the proposal's frontmatter `category: routine` (or a `Type: routine` line) **and** a `## Config` section with a JSON block: upsert into `config.json` after any skill/agent install below.

   **When the body also carries `## Skill Draft` and/or `## Agent Draft`:** run the install flow first (Procedure-capture install flow and the `## Agent Draft` install branch), then e.5 and e.6, then the upsert below; do not enter step 4's implementation ask. Before authoring, confirm each draft's `source_artifact` exists and is readable (search `compiled/`, then `compiled/.archive/`) — a missing or unreadable brief is the `stale-paths` rejection the step-4 gate would have raised: stop, leave `status: accepted`, write no routine, and tell the operator to re-run reflect for a fresh brief. Skip step 4's second full-artifact confirmation for this routine-bound branch only: intent was already approved through the bridged accept/dismiss ask; the skill is routine-bound, not chat-fired; the operator reverts by disabling the routine. Keep the collision guard, e.5 quality gate, and e.6 verification. A collision guard answered **Cancel** installs nothing — stop before the upsert too, so no routine is left scheduled against a skill that was never written. A standalone `## Skill Draft` with no `## Config` (Lane A) is not this branch — it keeps step 4's second confirmation.

   Then upsert:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts routine .claude-code-hermit <<'HERMIT_ROUTINE'
   <the ## Config JSON block, verbatim>
   HERMIT_ROUTINE
   ```
   The script validates `id`/`schedule`/`skill`/`enabled` are present and upserts by `id` — `OK|added` / `OK|updated`, or `ERROR|<reason>` (nothing written; report it and stop).
   - Notify the operator with one plain notice: saved (skill, and agent if any), first run time from the cron, how to stop (disable the routine).
   - Do not enter step 4 — the routine branch is complete.

4. Ask: **"How should this be implemented?"**

   **Channel-tagged turn:** do not wait interactively for a reply in this turn. Send the question via the channel reply tool in plain voice with the three options numbered — "Suggestion #N — start now, queue it as a task, or leave it to you?" (derive `#N` per `proposal-list` §4a). AND queue a pending micro-proposal entry:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .claude-code-hermit <<'HERMIT_MP'
   {"tier":1,"question":"Suggestion #N accepted — how should it be implemented?","options":["implement now","queued task","manual"],"on_resolve":"/claude-code-hermit:proposal-act accept PROP-NNN --answer {answer}","proposal_id":"PROP-NNN"}
   HERMIT_MP
   ```
   (the `on_resolve` and `proposal_id` ids stay `PROP-NNN` — internal, never shown; `proposal_id` is what retires this ask automatically if the proposal is resolved, dismissed, or deferred before the operator answers). Then stop — steps 1-3a already ran, so `status: accepted` is a safe resting state until the operator answers (immediately in this same conversational turn, or later via `branches.md` § Channel re-entry (`--answer`)). The interactive terminal path below is unchanged.

   - **"Start implementing now"** (default, typical answer): Read branches.md § Start implementing now.
   - **"Queue a task"** → Read branches.md § Queue a task.

   - **"I'll handle it manually"** → Just mark accepted. Respond: "Marked as accepted. No further action taken."

5. Notify the operator: "PROP-NNN accepted: [title]". On a channel-tagged turn (Step 0), use plain voice instead, matching the step-4 branch actually taken: **start now** → "Got it — starting on Suggestion #N."; **queued task** → "Queued Suggestion #N as a task."; **manual** → "Marked Suggestion #N as accepted — leaving it to you." (`#N` per `proposal-list` §4a.)

## Defer, dismiss, resolve, and channel re-entry

- `defer PROP-NNN` → Read branches.md § Defer Flow
- `dismiss PROP-NNN` → Read branches.md § Dismiss Flow
- `resolve PROP-NNN` → Read branches.md § Resolve Flow
- `accept PROP-NNN --answer "<label>"` → Read branches.md § Channel re-entry (`--answer`)
