#!/usr/bin/env bash
# Run Claude Code's native plugin validator over every plugin and the marketplace.
# Fails on any error, and on any warning except the plugin-root CLAUDE.md note:
# those files are contributor docs kept on purpose, which is also why --strict
# is never passed.
# Usage: bash scripts/plugin-validate.sh [root]   (default root: the repo root)
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
rc=0

targets=("$ROOT"/plugins/*/)
[ -f "$ROOT/.claude-plugin/marketplace.json" ] && targets+=("$ROOT/.claude-plugin/marketplace.json")

for target in "${targets[@]}"; do
  target="${target%/}"
  label="${target#"$ROOT"/}"
  # The validator exits 1 on errors, so its code is ignored and the report decides.
  # Empty output or a missing errors/warnings array makes jq fail, so a
  # report-shape change goes red too.
  if ! findings="$({ claude plugin validate --json "$target" || true; } | jq -rn --arg label "$label" '
      input
      | (.manifest, .contents[])
      | .errors[], (.warnings[] | select(.message | startswith("CLAUDE.md at the plugin root") | not))
      | "\($label): \(.path): \(.message)"')"; then
    echo "$label: validator report unreadable"
    rc=1
    continue
  fi
  if [ -n "$findings" ]; then
    echo "$findings"
    rc=1
  fi
done

exit "$rc"
