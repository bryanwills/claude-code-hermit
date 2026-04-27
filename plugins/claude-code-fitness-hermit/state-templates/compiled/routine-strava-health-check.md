---
title: "Routine: Strava Health Check"
type: routine-prompt
created: 2026-04-25T00:00:00+00:00
tags: [routine, strava]
---

# Routine: strava-health-check

Check whether Strava is still connected. Alert operator if disconnected.

## Steps

1. Call `mcp__strava__check-strava-connection`.
2. If **connected**: log one line to SHELL.md Progress Log — `[HH:MM] Strava health check: connected ✓` — and stop. No channel message.
3. If **disconnected**:
   - Log to SHELL.md Findings: `[YYYY-MM-DD] Strava connection lost — operator action needed. Re-authenticate via your runtime's standard OAuth flow (see .claude-code-hermit/bin/ or your Strava developer dashboard).`
   - Notify operator via Discord DM: "Strava disconnected. Re-authenticate using your runtime's standard OAuth flow (check .claude-code-hermit/bin/ scripts or run the hatch again)."
   - Do not retry or attempt reconnection.
