
---
<!-- claude-code-fitness-hermit: Fitness Workflow -->

## Fitness Workflow

This project has the `claude-code-fitness-hermit` plugin installed. The rules below apply whenever fitness or training work is in scope.

### Core Rules

- Always call `mcp__strava__check-strava-connection` first. If disconnected, stop and alert the operator.
- Never commit real Strava tokens or credentials.
- Never write tokens, credentials, or raw Strava user IDs to session files, proposals, or memory.
- Never call `star-segment`, `connect-strava`, or `disconnect-strava` without explicit operator instruction.
- Use `get-activity-streams` for load/intensity analysis — it's the richest data source.
- HR zone boundaries come from `mcp__strava__get-athlete-zones` — never hardcode numeric thresholds.

### Skills

| Skill | Purpose |
|-------|---------|
| `/claude-code-fitness-hermit:hatch` | One-time setup — Strava MCP, routines, CLAUDE.md injection |
| `/claude-code-fitness-hermit:activity-deep-dive` | Per-activity coaching analysis (zone breakdown, cardiac drift, recovery estimate) |

### Subagents

| Agent | Purpose |
|-------|---------|
| `@claude-code-fitness-hermit:strava-data-cruncher` | Bulk Strava data aggregation — weekly load tables, zone distributions (Haiku, cheap) |

### Strava MCP Tools

MCP server `strava` is configured in `.mcp.json` (written by `hatch`). Tool IDs follow `mcp__strava__*`.

| Tool | Use for |
|------|---------|
| `check-strava-connection` | Connectivity check — always call first |
| `get-athlete-profile` | Identity, location, weight, FTP |
| `get-athlete-stats` | Totals: YTD, recent, all-time distance/time/elevation |
| `get-athlete-zones` | HR zones, power zones |
| `get-recent-activities` | Last N activities (default 30) |
| `get-all-activities` | Full history with pagination |
| `get-activity-details` | Full detail on a single activity |
| `get-activity-streams` | Raw time-series: watts, HR, cadence, pace, altitude |
| `get-activity-laps` | Lap splits |
| `list-athlete-routes` | Saved routes |
| `explore-segments` | Find segments near a location |
| `list-starred-segments` | Favourite segments |

### Routines

These run automatically on their cron schedule (activate per session with `/claude-code-hermit:hermit-routines load`):

| Routine | Schedule | Purpose |
|---------|----------|---------|
| `strava-sync` | Daily 21:30 | Detect new activities, log them, flag anomalies |
| `strava-health-check` | Daily 08:05 | Check Strava connectivity; alert if lost |
| `weekly-load-review` | Sunday 18:00 | Week-over-week load summary + trend flag |
| `monday-planning` | Monday 09:30 | Weekly training structure suggestion |

Routine prompts are at `.claude-code-hermit/compiled/routine-*.md`.

### Conventions

- Activity notes: `compiled/activity-<id>-<YYYY-MM-DD>.md` (written by activity-deep-dive)
- Strava state cursor: `state/strava-last-activity-id.txt` (written by strava-sync)
- Weekly load baselines: `state/strava-weekly-baselines.json` (written by weekly-load-review, read by monday-planning)

<!-- /claude-code-fitness-hermit: Fitness Workflow -->
