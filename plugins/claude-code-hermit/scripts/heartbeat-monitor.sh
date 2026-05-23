#!/usr/bin/env bash
# Usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>
# Env: HEARTBEAT_MONITOR_ONCE=1  → run one iteration and exit (tests)
#      HEARTBEAT_PRECHECK=<path> → override precheck path (tests)
# Polls heartbeat-precheck.js --peek and emits a notification only when the
# LLM needs to wake up (EVALUATE or AUTO_CLOSE verdict). --peek means the
# polling itself is read-only; the mutating tick happens once when
# /heartbeat run re-runs precheck inside the EVALUATE handler.
set -u
INTERVAL="${1:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
HB_DIR="${2:?usage: heartbeat-monitor.sh <interval_seconds> <hermit_state_dir>}"
PRECHECK="${HEARTBEAT_PRECHECK:-$(dirname "$0")/heartbeat-precheck.js}"
while true; do
  verdict="$(node "$PRECHECK" --peek "$HB_DIR" 2>/dev/null || echo "ERROR")"
  case "$verdict" in
    EVALUATE*|AUTO_CLOSE*) echo "HEARTBEAT_EVALUATE" ;;
    OK|SKIP\|*)            : ;;  # silent — designed no-op
    ERROR*)                echo "HEARTBEAT_ERROR: precheck failed" ;;
    *)                     echo "HEARTBEAT_ERROR: unknown verdict: $verdict" ;;
  esac
  [[ -n "${HEARTBEAT_MONITOR_ONCE:-}" ]] && break
  sleep "$INTERVAL"
done
