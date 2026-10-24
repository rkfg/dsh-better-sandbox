#!/usr/bin/env bash
# Синтаксис всех модулей пакета и тестов.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
status=0
for f in "$root"/packages/*/lib/*.js "$root"/packages/*/*.js "$root"/test/*.js; do
  [[ -f $f ]] || continue
  node --check "$f" || { echo "синтаксис: $f" >&2; status=1; }
done
exit $status
