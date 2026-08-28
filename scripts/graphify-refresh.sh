#!/usr/bin/env bash
# Refresh the root graph plus one graph per plugin. AST-only, no API key needed.
# Root answers cross-plugin questions; each plugin graph answers questions scoped
# to that plugin, where the root graph loses the answer to test-harness noise.
set -euo pipefail

if [ "$(git rev-parse --path-format=absolute --git-dir)" \
     != "$(git rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "graphify-refresh: worktree detected, skipping (graphs live in the main checkout)" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"

echo "--- root"
graphify update .
for d in plugins/*/; do
  [ -f "${d}.claude-plugin/plugin.json" ] || continue
  echo "--- ${d}"
  (cd "$d" && graphify update .)
done
