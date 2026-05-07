#!/usr/bin/env bash
# Tests for archive-shell.js — mechanical SHELL.md snapshot helper.
# Usage: bash tests/test-archive-shell.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== archive-shell.js ==="
echo ""

ARCHIVE="$REPO_ROOT/scripts/archive-shell.js"

# -------------------------------------------------------
# 1. Missing SHELL.md → shell-empty, no snapshot, no runtime write
# -------------------------------------------------------
# Custom setup: needs runtime.json without last_shell_snapshot_at and NO SHELL.md.
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
echo '{"session_state":"idle"}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && node "$ARCHIVE" --source=manual)"
run_test "shell-empty (no SHELL.md)" bash -c "echo '$out' | grep -qF '\"archived\":false'"
run_test "shell-empty reason" bash -c "echo '$out' | grep -qF '\"reason\":\"shell-empty\"'"
run_test "no snapshots dir created on empty" bash -c "[ ! -d '$workdir/.claude-code-hermit/sessions/snapshots' ]"
run_test "runtime.json untouched on empty" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/runtime.json')); assert 'last_shell_snapshot_at' not in d or d.get('last_shell_snapshot_at') is None\""
cleanup

# -------------------------------------------------------
# 2. Empty (whitespace-only) SHELL.md → shell-empty
# -------------------------------------------------------
# Custom setup: needs whitespace-only SHELL.md (helper copies a real fixture).
workdir="$(mktemp -d)"
mkdir -p "$workdir/.claude-code-hermit/sessions"
mkdir -p "$workdir/.claude-code-hermit/state"
echo '{"session_state":"idle","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"
printf '   \n  \n' > "$workdir/.claude-code-hermit/sessions/SHELL.md"
out="$(cd "$workdir" && node "$ARCHIVE" --source=manual)"
run_test "shell-empty (whitespace only)" bash -c "echo '$out' | grep -qF '\"archived\":false'"
cleanup

# -------------------------------------------------------
# 3. Content SHELL.md → snapshot created, marker inserted, runtime updated
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"
out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine)"

run_test "content: archived true" bash -c "echo '$out' | grep -qF '\"archived\":true'"
run_test "content: snapshots dir exists" bash -c "[ -d '$workdir/.claude-code-hermit/sessions/snapshots' ]"
run_test "content: exactly one snapshot" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' | wc -l) -eq 1 ]"
run_test "content: snapshot filename matches SHELL-YYYYMMDD-HHMM.md" bash -c \
  "ls '$workdir/.claude-code-hermit/sessions/snapshots/' | grep -qE '^SHELL-[0-9]{8}-[0-9]{4}\\.md$'"
run_test "content: no S-NNN-REPORT.md created" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/' | grep -c '^S-[0-9]\\+-REPORT\\.md$' || true) -eq 0 ]"
run_test "content: SHELL.md still has Task section" \
  grep -q '^## Task' "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "content: SHELL.md still has Findings section" \
  grep -q '^## Findings' "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "content: SHELL.md has snapshot marker" \
  grep -q 'snapshot @' "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "content: SHELL.md has archived pointer" \
  grep -q '\[archived\] previous entries' "$workdir/.claude-code-hermit/sessions/SHELL.md"
run_test "content: runtime.json updated" bash -c \
  "python3 -c \"import json; d=json.load(open('$workdir/.claude-code-hermit/state/runtime.json')); assert d.get('last_shell_snapshot_at') is not None\""
run_test "content: pre-marker entries compacted" bash -c \
  "! grep -q 'Started test session' '$workdir/.claude-code-hermit/sessions/SHELL.md'"
snapshot_file="$(ls "$workdir/.claude-code-hermit/sessions/snapshots/"*.md | head -1)"
run_test "snapshot file: contains original entry" grep -q 'Started test session' "$snapshot_file"
run_test "snapshot file: has trailing boundary marker" grep -q 'snapshot @' "$snapshot_file"
cleanup

# -------------------------------------------------------
# 4. Concurrent invocation: two calls in same minute → only one snapshot
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"

first_out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine)"
# Same minute → same filename → EEXIST → concurrent.
second_out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine)"

run_test "concurrent: first archived" bash -c "echo '$first_out' | grep -qF '\"archived\":true'"
run_test "concurrent: second archived false" bash -c "echo '$second_out' | grep -qF '\"archived\":false'"
run_test "concurrent: second reason" bash -c "echo '$second_out' | grep -qF '\"reason\":\"concurrent\"'"
run_test "concurrent: exactly one snapshot file" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' | wc -l) -eq 1 ]"
cleanup

# -------------------------------------------------------
# 5. Idempotency across minutes: two calls in different minutes → two snapshots
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"

cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine >/dev/null
printf '\n## Active Work\nfresh content\n' >> "$workdir/.claude-code-hermit/sessions/SHELL.md"
cd "$workdir" && HERMIT_NOW='2026-05-06T23:00:00Z' node "$ARCHIVE" --source=routine >/dev/null
cd "$ORIG_DIR"

run_test "idempotency: two distinct snapshots created" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' | wc -l) -eq 2 ]"
run_test "idempotency: SHELL.md still has live sections" \
  grep -q '^## Task' "$workdir/.claude-code-hermit/sessions/SHELL.md"
cleanup

# -------------------------------------------------------
# 6. Namespace separation: never creates S-NNN-REPORT.md
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"
cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine >/dev/null
cd "$ORIG_DIR"

run_test "namespace: no S-NNN-REPORT.md in sessions/" bash -c \
  "[ \$(find '$workdir/.claude-code-hermit/sessions/' -maxdepth 1 -name 'S-*-REPORT.md' | wc -l) -eq 0 ]"
run_test "namespace: snapshot lives under sessions/snapshots/" bash -c \
  "[ -d '$workdir/.claude-code-hermit/sessions/snapshots' ]"
cleanup

# -------------------------------------------------------
# 7. Exit code is always 0 (fail-open)
# -------------------------------------------------------
# Custom setup: no state dir at all.
workdir="$(mktemp -d)"
cd "$workdir" && node "$ARCHIVE" >/dev/null 2>&1
ec=$?
cd "$ORIG_DIR"
run_test "fail-open: exit 0 with no state dir" bash -c "[ $ec -eq 0 ]"
cleanup

# -------------------------------------------------------
# 8. Missing runtime.json → snapshot still happens (fail-open on runtime write)
# -------------------------------------------------------
workdir="$(setup_workdir)"
rm "$workdir/.claude-code-hermit/state/runtime.json" 2>/dev/null || true
out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine)"
run_test "no-runtime: archived true" bash -c "echo '$out' | grep -qF '\"archived\":true'"
run_test "no-runtime: snapshot file written" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' | wc -l) -eq 1 ]"
run_test "no-runtime: SHELL.md still compacted" \
  grep -q '\[archived\] previous entries' "$workdir/.claude-code-hermit/sessions/SHELL.md"
cleanup

# -------------------------------------------------------
# 9. SHELL.md without ## Progress Log → snapshot taken, warning surfaced,
#    compacted:false in JSON, SHELL.md left untouched
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"
# Replace SHELL.md with content that lacks the Progress Log heading.
cat > "$workdir/.claude-code-hermit/sessions/SHELL.md" <<'EOF'
# Active Session

## Task
Drift test — Progress Log heading deliberately absent.

## Findings
Some content here.
EOF
shell_before="$(cat "$workdir/.claude-code-hermit/sessions/SHELL.md")"
out="$(cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine 2>/tmp/archive-stderr.$$)"
stderr="$(cat /tmp/archive-stderr.$$)"
rm -f /tmp/archive-stderr.$$
run_test "no-progress-log: archived true" bash -c "echo '$out' | grep -qF '\"archived\":true'"
run_test "no-progress-log: compacted:false in JSON" bash -c "echo '$out' | grep -qF '\"compacted\":false'"
run_test "no-progress-log: warning on stderr" bash -c "echo '$stderr' | grep -q 'no .* Progress Log'"
run_test "no-progress-log: SHELL.md unchanged" bash -c \
  "[ \"\$(cat '$workdir/.claude-code-hermit/sessions/SHELL.md')\" = \"$shell_before\" ]"
run_test "no-progress-log: snapshot file written" bash -c \
  "[ \$(ls '$workdir/.claude-code-hermit/sessions/snapshots/' | wc -l) -eq 1 ]"
cleanup

# -------------------------------------------------------
# 10. No partial snapshots left behind (no .tmp.<pid> file after run)
# -------------------------------------------------------
workdir="$(setup_workdir)"
echo '{"session_state":"in_progress","last_shell_snapshot_at":null}' > "$workdir/.claude-code-hermit/state/runtime.json"
cd "$workdir" && HERMIT_NOW='2026-05-06T22:00:00Z' node "$ARCHIVE" --source=routine >/dev/null
cd "$ORIG_DIR"
run_test "no-tmp: no .tmp.<pid> snapshot leftover" bash -c \
  "[ \$(find '$workdir/.claude-code-hermit/sessions/snapshots/' -name '*.tmp.*' | wc -l) -eq 0 ]"
cleanup

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
print_results
