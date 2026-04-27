# Dev Log Watch — recipe for tailing rotating dev logs

A reference recipe for wiring a rotating dev-server log into a `/watch` monitor entry. Use when your dev server writes to a date-stamped file that gets replaced at midnight.

---

## When to use this

Use this recipe when your dev server writes to a **date-rotated file** where the active filename changes — e.g., Winston daily transport (`app-2026-04-27.log`), Pino with a date-suffixed transport, or structlog's `TimedRotatingFileHandler`.

**Skip this recipe if your logs go elsewhere:**

| Log destination | Use instead |
|---|---|
| stdout / stderr | Redirect to a file (`server >> dev.log 2>&1`) and `tail -F dev.log`, or use a process supervisor |
| systemd-journald | `journalctl -fu <service>` |
| Docker / Podman | `docker logs -f <container>` |
| Fixed-path file (no rotation, or size-rotation only — Rails, default Winston file transport) | `tail -F <path>` directly |

---

## The two non-obvious gotchas

### 1. Block-buffered pipes silence the watch

`tail -F file | grep ERROR` works on the terminal but **produces no output** when run as a background monitor. The reason: `grep` switches to block buffering when stdout is not a TTY, so it collects kilobytes of input before flushing — meaning your errors sit invisible in a buffer until the buffer fills.

Fix: prefix both `tail` and `grep` with `stdbuf -oL` to force line buffering:

```bash
stdbuf -oL tail -F "$LOG" | stdbuf -oL grep -E '<pattern>'
```

### 2. Date resolved once goes stale at midnight

A naive `LOG="app-$(date +%Y-%m-%d).log"` picks the correct filename at startup — but at midnight the active filename changes (`app-2026-04-28.log`) while your `tail -F` keeps watching yesterday's path. New log lines go to the new file; you see nothing.

Fix: wrap the entire command in a `while` loop that restarts after sleeping until midnight, re-evaluating the date on each iteration.

---

## Reference recipe

```bash
while true; do
  LOG="logs/app-$(date +%Y-%m-%d).log"
  NEXT_MIDNIGHT=$(date -d 'tomorrow 00:00:00' +%s 2>/dev/null \
    || date -v+1d -v0H -v0M -v0S +%s)   # GNU date / BSD date fallback
  NOW=$(date +%s)
  SECS=$(( NEXT_MIDNIGHT - NOW ))
  timeout "${SECS}s" \
    stdbuf -oL tail -F "$LOG" 2>/dev/null \
    | stdbuf -oL grep -E '<error pattern>' \
    | stdbuf -oL grep -Ev '<noise pattern>'
  # loop restarts after midnight, picking up the new date
done
```

Wire this as a `command` inside a `monitors[]` entry in `.claude-code-hermit/config.json`. The `timeout` ensures the outer process exits cleanly at midnight so the loop can re-evaluate `$(date)`.

---

## Adapting for your project

| Stack | Log path pattern | Starter error pattern |
|---|---|---|
| Winston daily transport | `logs/app-$(date +%Y-%m-%d).log` | `"level":"error"` or `ERROR` |
| Pino with date-suffixed transport | `logs/$(date +%Y-%m-%d).ndjson` | `"level":50` (error level in pino) |
| structlog (Python) `TimedRotatingFileHandler` | `logs/app-$(date +%Y-%m-%d).log` | `"level": "error"` |

For Winston, if you're using a custom `filename` option like `app-%DATE%.log` where `%DATE%` is `YYYY-MM-DD`, substitute accordingly.

---

## False-positive avoidance

Patterns to **exclude** (`grep -Ev`) alongside your error match — adjust to your stack:

- `warn` / `warning` level entries you don't care about in dev
- `0 errors` cleanup summary lines (e.g., TypeScript watch mode)
- `compiled successfully` / `ready` startup noise
- Health-check or heartbeat request logs that match coincidentally

Keep the exclusion list in your monitor `command` string, not in a separate file — that way it's visible at a glance when reviewing the monitor.

---

## See also

- [`claude-code-hermit:watch`](../../claude-code-hermit/skills/watch/SKILL.md) — background monitoring via CC Monitor. Wire the recipe above as a `command` in the `monitors[]` config array. Use this recipe when a plain `tail -F` against a static path won't survive midnight rotation.
- [`claude-code-hermit:watch` docs](../../claude-code-hermit/docs/config-reference.md) — config schema for monitor entries.
