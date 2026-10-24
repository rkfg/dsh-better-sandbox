#!/usr/bin/env bash
# Устанавливает обе коробки в профиль и включает их в dsh.profile.bundles.
# Состав строк описан в patch-слое бандла, поэтому в cordis.patch.yml профиля
# остаются только значения списков.
#
#   ./scripts/install.sh                                  # профиль web
#   ./scripts/install.sh --home <dir> --profile <имя>     # другой DSH_HOME/профиль
#   ./scripts/install.sh --drop <старое-имя>              # убрать старое имя пакета
#
# --drop нужна после переименования пакета: иначе в профилях остаются строки и
# папки старого имени, а два пакета с одним именем пакета роняют загрузку
# страницы («duplicate factory registration»).
#
# Штатная установка плагина — `dsh plugin --profile <name> add @rkfg/dsh-sandbox-allowlist`.
# Этот скрипт нужен для установки из рабочего дерева: он проверяет синтаксис,
# делает копию package.json профиля и пересоздаёт нулёвки маски, которые
# запущенный харнесс передаёт в bwrap как пути-источники.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
home=${DSH_HOME:-"$HOME/.dsh"}
profile=web
declare -a drop=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --home) home=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    --drop) drop+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

src="$root/packages/@rkfg/dsh-sandbox-allowlist"
uipkg="$root/packages/@rkfg/dsh-sandbox-allowlist-ui"
prof="$home/profiles/$profile"
dst="$prof/node_modules/@rkfg/dsh-sandbox-allowlist"
uirst="$prof/node_modules/@rkfg/dsh-sandbox-allowlist-ui"
[[ -d "$prof" ]] || { echo "нет профиля: $prof" >&2; exit 1; }

export DROP
DROP=$(printf '%s\n' "${drop[@]:-}" | sed '/^$/d')
bash "$root/scripts/lint.sh" || exit 1

if [[ -e "$dst" ]]; then
  prev=$(node -e 'const p=require(process.argv[1]);console.log(p.version??"")' "$dst/package.json" 2>/dev/null || echo неизвестно)
  rm -rf "$dst"
  echo "обновлена предыдущая установка (версия $prev)"
fi
mkdir -p "$prof/node_modules/@rkfg"
cp -r "$src" "$dst"
rm -rf "$dst/lib/.mask"

# Нулёвки маски mode 000 лежат в папке плагина и уходят в bwrap как пути-источники:
# если их нет, confine падает у каждой команды («Can't find source path»), поэтому
# их создаёт и сам плагин перед каждой командой, и установщик — сразу после копирования.
mask="$dst/lib/.mask"
mkdir -p "$mask/empty-dir"
: > "$mask/empty-file"
chmod 000 "$mask/empty-dir" "$mask/empty-file"

# Коробка с разделом настроек — отдельный пакет: пакет с клиентской половиной
# обязан иметь ровно одну запись загрузчика.
rm -rf "$uirst"
cp -r "$uipkg" "$uirst"

node -e "$(cat <<'NODE'
const fs = require('fs')
const path = require('path')
const file = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
const wanted = ['@rkfg/dsh-sandbox-allowlist', '@rkfg/dsh-sandbox-allowlist-ui']
const dropped = (process.env.DROP ? process.env.DROP.split('\n').filter(Boolean) : [])
for (const name of dropped) {
  const index = pkg.dsh.profile.bundles.indexOf(name)
  if (index !== -1) pkg.dsh.profile.bundles.splice(index, 1)
  fs.rmSync(`${path.dirname(file)}/node_modules/${name.replace('/', '/').replace('@', '@')}`, { recursive: true, force: true })
  console.log(`убрано старое имя: ${name}`)
}
const missing = wanted.filter((name) => !pkg.dsh.profile.bundles.includes(name))
if (dropped.length === 0 && missing.length === 0) {
  console.log('обе коробки уже в bundles')
} else {
  const backup = `${file}.bak-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.writeFileSync(backup, fs.readFileSync(file, 'utf8'))
  pkg.dsh.profile.bundles.push(...missing)
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`добавлено в bundles: ${missing.join(', ')} (копия: ${backup})`)
}
NODE
)" "$prof/package.json"

echo "установлено: $dst"
echo "установлено: $uirst"
echo "в профиле достаточно значений: - id: sandbox-allowlist / name: '@rkfg/dsh-sandbox-allowlist/allowlist' / config: { writableDirs: [...], readDenyDirs: [...], readDenyFiles: [...], denySegments: [...] }"
echo 'нужен рестарт профиля'
