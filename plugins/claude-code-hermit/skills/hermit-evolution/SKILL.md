---
name: hermit-evolution
description: "Show cost trend, autonomy delta, and proposal-resolution times across recent weeks. Activates on messages like 'how am I trending', 'cost trend', 'autonomy', 'hermit evolution', 'show me my trajectory', 'am I improving', 'proposal velocity', 'weekly trends'."
---
# Hermit Evolution

Synthesize a compact analytical snapshot of the hermit's trajectory over recent weeks: cost trend, autonomy rate, and how fast proposals move through the pipeline.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Scope

Read the following (gracefully skip any file that doesn't exist):

1. `.claude-code-hermit/compiled/review-weekly-*.md` — glob all, sort by `week` frontmatter descending, read the 8 most recent. Extract per-file: `week`, `total_cost_usd`, `self_directed_rate`, `proposals_created`, `proposals_resolved`.
2. `.claude-code-hermit/cost-summary.md` — frontmatter `total_cost_usd` and `total_tokens` for the current (partial) week's running total if the review file for the current week doesn't exist yet.
3. `.claude-code-hermit/state/proposal-metrics.jsonl` — if present, scan from the end (most recent entries first); stop once entries are older than 30 days. Use `resolved_at` and `created_at` to compute resolution days for recently resolved proposals.

## Analysis

**Cost:** From review files, extract `total_cost_usd` per week. Show the 4 most recent weeks as a trend. Compute Δ% between the most recent and the preceding week. If fewer than 2 reviews exist, show "not enough data".

**Autonomy:** From review files, extract `self_directed_rate` (fraction of sessions with no operator turns). Show latest value and Δ vs prior week. Higher = more self-directed. If fewer than 2 reviews exist, show "not enough data".

**Proposal resolution:** From `proposal-metrics.jsonl`, compute median days between `created_at` and `resolved_at` for proposals resolved in the last 30 days. If no data: "no resolution data yet". (For specific stale proposal names, use `/hermit-brain`.)

## Output

Reply in ≤1500 chars. Use exactly this section structure:

```
### Cost
- This week: $X.XX | Prior: $Y.YY (Δ +/-N%)
- 4-week trend: $A → $B → $C → $X
(or: Cost trend — not enough weekly reviews to compute (need ≥2).)

### Autonomy
- Self-directed: N% this week (vs M% prior, Δ +/-N pp)
(or: Autonomy — not enough weekly reviews to compute (need ≥2).)

### Proposal resolution
- Median resolution: Nd (from N proposals resolved last 30d)
(or: Proposal resolution — no proposal-metrics data yet.)
```

Omit sections that have no data rather than showing a heading with an empty body. Keep each bullet to one line.
