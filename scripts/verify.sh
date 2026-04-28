#!/bin/bash
# Back-pressure verification — silent on success, verbose on failure.
# This repo's real quality gates are the npm test scripts documented in package.json,
# README.md, and AGENTS.md:
#   - npm test              -> full suite
#   - npm run test:direct   -> fast subset (skips document-reviewer integration)
#
# Usage:
#   bash scripts/verify.sh
#   bash scripts/verify.sh --quick

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

source "$SCRIPT_DIR/run_silent.sh"

usage() {
  echo "Usage: bash scripts/verify.sh [--quick]" >&2
}

if [[ $# -gt 1 ]]; then
  usage
  exit 64
fi

case "${1:-}" in
  "")
    run_silent "full test suite" npm test >/dev/null
    ;;
  --quick)
    run_silent "direct test suite" npm run test:direct >/dev/null
    ;;
  *)
    usage
    exit 64
    ;;
esac
