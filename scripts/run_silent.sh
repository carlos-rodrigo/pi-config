#!/bin/bash
# Context-efficient command runner — silent on success, verbose on failure.
# Source this file, then call: run_silent "description" "command"

run_silent() {
  local description="$1"
  shift
  local tmp_file
  tmp_file=$(mktemp)

  if "$@" > "$tmp_file" 2>&1; then
    printf "  ✓ %s\n" "$description"
    rm -f "$tmp_file"
    return 0
  else
    local exit_code=$?
    printf "  ✗ %s\n" "$description" >&2
    cat "$tmp_file" >&2
    rm -f "$tmp_file"
    return $exit_code
  fi
}
