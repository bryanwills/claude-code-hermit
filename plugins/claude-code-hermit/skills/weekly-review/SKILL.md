---
name: weekly-review
description: Generate the weekly review report for the current ISO week. Writes to .claude-code-hermit/compiled/review-weekly-YYYY-Www.md and sends a channel-friendly summary with an evolution block. Runs every Sunday at 23:00 via routine.
---
# Weekly Review

Generates the weekly review for the current ISO week.

## Steps

1. Run:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/weekly-review.ts .claude-code-hermit
   ```

2. Report the result. On success, output the review filename. If a **Knowledge Health** section appears in the review output, summarize the issues to the operator.

3. Semantic check of topic pages (read-only, no script). Read every `compiled/topic-*.md` and look for:
   - claims contradicted by another topic page or by a more recent session report
   - stale claims — old `updated` date on a subject with recent session activity
   - broken `[[wikilinks]]` — targets that match no compiled page or memory entry

   Cap at 3 findings, one line each. If any, include them in the channel summary (step 5) under a `Topic pages:` line. If none, or no topic pages exist, skip silently.

4. Build the weekly evolution block from the freshly-written review file:
   - Read `.claude-code-hermit/compiled/review-weekly-<current-week>.md` frontmatter (just written in step 1).
   - Also read the prior week's `compiled/review-weekly-*.md` frontmatter (sort by `week` descending, take the second file).
   - Compute deltas directly from frontmatter values (no synthesis or inference) and format:
     ```
     ## This week's evolution
     - Cost: $X.XX (vs $Y.YY prior week, Δ+/-N%)
     - Autonomy: N% self-directed (vs M% prior, Δ+/-N pp)
     - Proposals: +A created, B resolved (C pending review, D in flight)
     - Oldest open accepted: PROP-NNN (Nd since accepted) [or "none"]
     - Reflect: <the `reflect:` line from the review body's ### Reflect section, or "no reflect runs">
     ```
   - If no prior week file exists: omit the "vs" comparisons and show this week's numbers only.
   - If the current-week file is missing (script failed): skip the evolution block entirely.

5. Channel-send the combined weekly summary:
   - Compose the message: one-line review headline (session count, cost, self-directed rate from frontmatter) followed by the evolution block from step 4, plus the `Topic pages:` findings from step 3 when present.
   - Resolve the outbound channel:
     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .claude-code-hermit
     ```
     Parse stdout as JSON. On success (`"id"` and `"chat_id"` present), send via `mcp__plugin_<id>_<id>__reply` with `{ chat_id, text: <message> }` where `<id>` is the resolved channel name.
   - If the script exits non-zero or returns `{"error":"no_reachable_channel"}`: if `push_notifications === true` in `config.json`, fire `PushNotification(message="<one-line weekly review headline>", status="proactive")` so the summary still reaches the operator. Then append a single Findings line to `.claude-code-hermit/sessions/SHELL.md`: `"weekly-review: no reachable channel configured, channel-send skipped"`. Only log this once per session to avoid noise. Do **not** emit a `channel-send-unavailable` alert issue (weekly-review is a recurring routine, not an alert).
   - To set a preferred channel, add `"primary": "<channel-name>"` inside `channels` in `config.json`.

6. Archive expired raw artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-raw.ts .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

7. Archive superseded compiled artifacts:
   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/archive-compiled.ts .claude-code-hermit
   ```
   Report how many were archived, retained, and skipped.

## Notes

- Safe to run manually at any time — re-runs overwrite the current week's review.
- The routine is enabled by default for new installs. Existing operators who haven't opted in can enable it via `/claude-code-hermit:hermit-settings`.
- `archive-raw.ts` only moves files — it never deletes. Archived files land in `raw/.archive/` and can be restored manually.
- `archive-compiled.ts` only moves files — it never deletes. Keeps the newest 2 artifacts per type; `foundational`-tagged artifacts and `topic` pages are always retained (living pages compact by merging, not archival). Archived files land in `compiled/.archive/` and can be restored manually.
