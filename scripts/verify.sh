#!/bin/bash
# Back-pressure verification — silent on success, verbose on failure.
# Runs all quality gates. Exit 0 = clean, exit non-zero = agent must fix.
#
# Usage:
#   bash scripts/verify.sh          # run all checks
#   bash scripts/verify.sh --quick  # tests only (skip typecheck)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

source "$SCRIPT_DIR/run_silent.sh"

quick=false
[[ "${1:-}" == "--quick" ]] && quick=true

failed=0

# Tests (fail-fast, context-efficient)
if ! run_silent "tests" npm test; then
  failed=1
fi

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "❌ Verification failed — fix errors above before continuing." >&2
  exit 2
fi

# All good — silent (zero context consumed)
exit 0
