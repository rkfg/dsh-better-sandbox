#!/usr/bin/env bash
# Проверка загрузки страницы: поднимает изолированный веб-профиль с обеими
# коробками и грузит его в headless-браузере. Нужна именно она, потому что
# клиентская половина может быть сломана при полностью рабочем хосте, и хост-логи
# об этом молчат.
#
#   ./scripts/page-check.sh            # загрузка страницы + UI-тест раздела настроек
#   UI_PROBE=0 ./scripts/page-check.sh # только загрузка страницы
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
  echo "сервер не поднялся, последние строки лога:"
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
