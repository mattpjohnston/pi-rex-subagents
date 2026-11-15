#!/usr/bin/env bash
# Every check a commit must pass, one summary line each. The last run hides rex and pi from
# PATH, because CI has neither and tests that reach them by accident pass locally.
set -u
cd "$(dirname "$0")/.."
fail=0
run() {
  local name=$1
  shift
  local out code
  out=$("$@" 2>&1)
  code=$?
  if [ $code -eq 0 ]; then
    echo "$name: pass $(printf '%s\n' "$out" | grep -E '^ +Tests ' | tr -s ' ')"
  else
    echo "$name: FAIL (exit $code)"
    printf '%s\n' "$out" | tail -40
    fail=1
  fi
}
run typecheck pnpm -s typecheck
run lint pnpm -s lint
run fmt:check pnpm -s fmt:check
run test pnpm -s test
run models pnpm -s models
bare=$(mktemp -d)
# pnpm's node is a shim that needs pnpm on PATH, so link the binary it runs.
ln -s "$(node -p process.execPath)" "$bare/node"
ln -s "$(command -v git)" "$bare/git"
run "test (no rex or pi on PATH)" env PATH="$bare:/usr/bin:/bin:/usr/sbin:/sbin" node node_modules/vitest/vitest.mjs run
rm -rf "$bare"
exit $fail
