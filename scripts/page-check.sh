#!/usr/bin/env bash
# Page load check: boots an isolated web profile with both packages and loads it
# in a headless browser. This is the check that matters, because the client half
# can be broken while the host works perfectly, and the host logs stay silent
# about it.
#
#   ./scripts/page-check.sh            # page load + UI test of the Settings section
#   UI_PROBE=0 ./scripts/page-check.sh # page load only
#   CHROME_BIN=google-chrome ./scripts/page-check.sh
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
port=${DSH_TEST_PORT:-3184}
log="$root/.dsh-test/logs/page-check.log"

mkdir -p "$root/.dsh-test/logs"
DSH_BUNDLE=1 DSH_UI=1 DSH_TEST_PORT="$port" bash "$root/scripts/webfull.sh" serve >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null; wait "$server" 2>/dev/null' EXIT

url=''
for _ in $(seq 1 60); do
  sleep 1
  url=$(grep -oE "http://127.0.0.1:${port}/\?token=[A-Za-z0-9_-]*" "$log" | head -1)
  [[ -n $url ]] && break
done
if [[ -z $url ]]; then
  echo "the server did not come up, last lines of the log:"
  tail -8 "$log"
  exit 1
fi

node "$root/test/page-probe.mjs" "$url"
status=$?
if [[ $status -eq 0 && ${UI_PROBE:-1} != 0 ]]; then
  node "$root/test/settings-ui-probe.mjs" "$url" || status=$?
fi
kill "$server" 2>/dev/null
wait "$server" 2>/dev/null
trap - EXIT
exit $status
