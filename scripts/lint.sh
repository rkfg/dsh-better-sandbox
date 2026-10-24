#!/usr/bin/env bash
# Syntax check for every package module and for the tests.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for f in "$root"/packages/*/lib/*.js "$root"/packages/*/*.js "$root"/test/*.js "$root"/test/*.mjs; do
  [[ -f $f ]] || continue
  node --check "$f" || { echo "syntax: $f" >&2; status=1; }
done
exit $status
