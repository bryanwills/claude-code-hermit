#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
rc=0

bun "$SCRIPT_DIR/cli.test.ts" || rc=$?

exit $rc
