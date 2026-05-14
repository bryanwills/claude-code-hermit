---
name: ha-analyze-patterns
description: Analyze Home Assistant history data and entity patterns to identify automation opportunities, unused devices, and energy anomalies. Use periodically or when looking for optimization opportunities.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
---

# HA Pattern Analysis

## Steps

1. **Load existing analysis**: Read `.claude-code-hermit/raw/snapshot-ha-pattern-analysis-latest.json` if it exists.
2. **Get live context**: Call `GetLiveContext` and `GetDateTime` via MCP for current state.
3. **Read normalized inventory**: Read `.claude-code-hermit/raw/snapshot-ha-normalized-latest.json`. Extract both `entity_index` and `silence_summary` (the new block added by every context refresh).
4. **Analyze patterns from silence_summary**:

   From `silence_summary.dead_automations` (enabled automations not fired in 30+ days):
   - Each entry is an actionable Reliability issue: `"automation.X has not fired in N days (enabled)"`.
   - `never_fired: true` entries get special phrasing: `"automation.X has never fired (enabled but never triggered)"`.

   From `silence_summary.silent_event_sensors` (motion/door/window sensors silent for 7+ days):
   - Each entry is an actionable Reliability issue: `"binary_sensor.X (<device_class>) — no events in N days"`.

   From `silence_summary.long_unavailable` (individual entities unavailable 7+ days, domain not already degraded):
   - Each entry is a Reliability issue: `"entity.X unavailable for N days"`.

   From `silence_summary.inactive_candidates_by_domain` (lights/switches/covers/climates unchanged for 7+ days):
   - Surface in the Markdown patterns artifact only. Do **not** include in the stdout findings block — these are informational, not actionable without corroboration.

   From `silence_summary.suppressed_entity_domains`:
   - Note in Markdown artifact that these domains are already covered by ha-integration-health.

5. **Write findings**: Save pattern data to `.claude-code-hermit/raw/snapshot-ha-pattern-analysis-<YYYY-MM-DD>.json` and update `snapshot-ha-pattern-analysis-latest.json`. Write the curated Markdown summary (when non-trivial findings exist) to `.claude-code-hermit/raw/patterns-<YYYY-MM-DD>.md` with frontmatter `type: analysis`, `title: "HA Pattern Analysis — <YYYY-MM-DD>"`, `created: <ISO8601>`, `session: <session_id or null>`, `tags: [ha-patterns, analysis]`. Also write `patterns-latest.md` pointing to the same content. The Markdown body should include the richer breakdown: `inactive_candidates_by_domain` summary table and `suppressed_entity_domains` note.
6. **Update memory**: Update your auto memory with key findings from this analysis.
7. **Emit summary for reflect-scheduled-checks**: Always output a plain-text findings block to stdout. reflect-scheduled-checks routes actionable items through the proposal pipeline. The stdout shape is fixed — do not add new top-level sections:

   ```
   ha-analyze-patterns findings — <date>
   Automation opportunities: <N>
   - <opportunity 1>
   Reliability issues: <N>
   - <dead automation or silent sensor or long-unavailable entity>
   Waste patterns: <N>
   - <waste 1>
   No action needed: <list anything normal or already automated>
   ```

   Dead automations and silent event sensors fold under `Reliability issues:`. If there are zero findings across all categories, output: `ha-analyze-patterns findings — <date>\nNo actionable findings.`

8. **Propose automations**: If clear patterns emerge, suggest them. For complex ones, delegate to `@claude-code-homeassistant-hermit:ha-automation-builder`.

## What to Look For

- **Dead automations**: enabled automations with no recent triggers — often broken silently after an HA upgrade
- **Silent event sensors**: motion/door/window sensors that haven't fired — may be stuck, dead, or unused
- **Long-unavailable entities**: individual entities down for 7+ days (domain not covered by integration-health)
- **Time patterns**: lights/devices that follow daily schedules; repeated manual actions the operator performs at the same time of day — both are candidates for time-based automations
- **Correlation patterns**: events that always happen together (candidates for grouped automations); manual action sequences that could be a single trigger
- **Waste patterns**: devices left on for long periods, unnecessary power draw

## Output

- `.claude-code-hermit/raw/snapshot-ha-pattern-analysis-<date>.json` (raw pattern data, machine-readable)
- `.claude-code-hermit/raw/snapshot-ha-pattern-analysis-latest.json` (fixed-name alias for latest)
- `.claude-code-hermit/raw/patterns-<date>.md` (curated Markdown summary, written when non-trivial findings exist; `type: analysis`)
- `.claude-code-hermit/raw/patterns-latest.md` (fixed-name alias for latest)
- Updated auto memory with key findings
