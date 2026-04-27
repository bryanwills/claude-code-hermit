# claude-code-fitness-hermit

A fitness/training domain layer for [`claude-code-hermit`](https://github.com/gtapps/claude-code-hermit) — Strava MCP integration, activity analysis skills, and cron-driven routine templates for an autonomous training assistant.

---

## Prerequisites

Before installing this plugin you need:

- **Claude Code** with a paid Claude plan
- **`claude-code-hermit` ≥1.0.21** installed and hatched in your project (run `/claude-code-hermit:hatch` first)
- **A Strava developer app** with four OAuth credentials:
  - `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` — from your app at https://www.strava.com/settings/api
  - `STRAVA_ACCESS_TOKEN` and `STRAVA_REFRESH_TOKEN` — from the OAuth authorization flow
  - See https://developers.strava.com/docs/authentication/ for the full setup

---

## Quick Start

### 1 — Install the plugin

```
claude plugin marketplace add gtapps/claude-code-hermit
claude plugin install claude-code-fitness-hermit@claude-code-hermit --scope project
```

### 2 — Run the setup wizard

```
/claude-code-fitness-hermit:hatch
```

The wizard will:
1. Confirm `claude-code-hermit` is already set up
2. Prompt you to copy `.env.example` → `.env` and fill in your Strava credentials
3. Write `.mcp.json` with the Strava MCP server entry
4. Drop four routine prompt templates into `.claude-code-hermit/compiled/`
5. Inject the Fitness Workflow block into your `CLAUDE.md`
6. Register four routines in `.claude-code-hermit/config.json`

### 3 — Activate

Restart Claude Code when prompted (required to pick up the new `.mcp.json`), approve the `strava` MCP server, then run `/mcp` to confirm.

For always-on deployments, use your hermit's standard start command — routines activate automatically.

---

## What Ships

### Skills

| Skill | Description |
|-------|-------------|
| `/claude-code-fitness-hermit:hatch` | One-time setup wizard (idempotent, run once per project) |
| `/claude-code-fitness-hermit:activity-deep-dive` | Per-activity coaching analysis: zone breakdown, pace/HR efficiency, cardiac drift, recovery estimate. Saves a compiled artifact. Usage: `activity-deep-dive <id>` or `activity-deep-dive latest` |

### Subagent

| Agent | Description |
|-------|-------------|
| `@claude-code-fitness-hermit:strava-data-cruncher` | Haiku bulk-aggregation agent for multi-week trend tables, zone distributions, and efficiency metrics. Caps at 30 API calls per invocation. |

### Routines (cron-driven)

Dropped into `.claude-code-hermit/compiled/` by `hatch` and registered in `config.json`:

| Routine ID | Schedule | Purpose |
|------------|----------|---------|
| `strava-sync` | Daily 21:30 | Detect new activities, log them, flag anomalies |
| `strava-health-check` | Daily 08:05 | Check Strava connectivity; alert if lost |
| `weekly-load-review` | Sunday 18:00 | Week-over-week load summary with trend flag |
| `monday-planning` | Monday 09:30 | Weekly training structure suggestion |

Activate per session with `/claude-code-hermit:hermit-routines load`.

---

## MCP Scope

This plugin connects to Strava via [`@r-huijts/strava-mcp-server`](https://github.com/r-huijts/strava-mcp-server) (installed automatically via `npx` on first use). The MCP server is registered under the key `strava` in `.mcp.json`.

Supported operations: all read-class tools (activities, streams, zones, segments, routes). Write-class tools (`star-segment`, `connect-strava`, `disconnect-strava`) are blocked by `settings.json` and should never be called without explicit operator instruction.

Extension points: Garmin, Apple Health, Polar, and other fitness integrations are not included but can be added by creating additional MCP server entries in `.mcp.json`.

---

## Security

- `.env` and `.mcp.json` are gitignored — verify before any `git push`.
- The four Strava credentials in `.env` are written as literal values into `.mcp.json` (required for the MCP server's child process). They are not committed.
- Never log, print, or write token values to session files, proposals, or memory.
- The base hermit's deny-patterns hook blocks any Bash command whose argument string contains the literal `TOKEN` — this plugin's hatch uses the `Read` tool to access `.env`, not shell commands.

---

## License

MIT — see [LICENSE](./LICENSE).
