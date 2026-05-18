---
name: hermit-brain
description: "Show fragile zones, stale accepted proposals, and recent learnings drawn from session history, proposals, and reflect output. Activates on messages like 'what's stuck', 'any fragile zones', 'show me what's blocked', 'recent learnings', 'hermit brain', 'what have you learned lately', 'where are the weak spots'."
---
# Hermit Brain

Synthesize a compact analytical snapshot of the hermit's current knowledge state: where things are fragile, which accepted proposals have stalled, and what has been recently learned.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Scope

Read the following (gracefully skip any file that doesn't exist):

1. `.claude-code-hermit/sessions/SHELL.md` — current session context, tags, blockers
2. `.claude-code-hermit/sessions/S-*-REPORT.md` — glob all, sort descending by filename, read the 5 most recent; parse `status`, `tags`, `proposals_created` frontmatter
3. `.claude-code-hermit/proposals/PROP-*.md` — glob all; for each read `id`, `title`, `status`, `accepted_date`, `resolved_date`, `tags` from frontmatter
4. `.claude-code-hermit/state/reflection-state.json` — `last_reflection`, `queue` (pending micro-proposals and reflect candidates)

## Analysis

**Fragile zones:** From the last 5 session reports, gather the `tags` array from sessions with `status: partial` or `status: blocked`. Also gather `tags` from proposals with `status: dismissed` or `status: blocked`. Surface the top 2–3 tag clusters that appear repeatedly across fragile outcomes. If no blocked/partial sessions exist: "No fragile zones detected."

**Stale proposals:** From proposals, find those with `status: accepted` and `resolved_date` absent or `null`. Sort by `accepted_date` ascending (oldest first). Show up to 3. Compute days open = today minus `accepted_date`. If none: "No accepted proposals awaiting resolution."

**Recent learnings:** From `reflection-state.json`, read `queue` entries with `status: accepted` or `status: pending` and surface the most recent 3 question/observation fields. If the queue is empty or absent, scan the current SHELL.md Progress Log for notable Findings entries (lines beginning with `-` under `## Findings`). Surface top 3. If nothing: "No recent learnings — reflect hasn't run yet."

## Output

Reply in ≤1500 chars. Use exactly this section structure:

```
### Fragile zones
- [tag or theme]: [one-line reason]
(or: No fragile zones detected — no blocked/partial sessions yet.)

### Stale proposals
- PROP-NNN: [title] (accepted N days ago)
(or: No accepted proposals awaiting resolution.)

### Recent learnings
- [learning]
(or: No recent learnings — reflect hasn't run yet.)
```

Omit sections that have no data rather than showing a heading with an empty body. Keep each bullet to one line.
