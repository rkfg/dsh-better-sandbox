#!/usr/bin/env bash
# Головной контур проверки: один и тот же драйвер прогоняется против базовых
# провайдеров харнесса и против плагина. Всё внутри репозитория: DSH_HOME
# указывает на .dsh-test, записи вне репозитория нет, основной профиль не
# затрагивается.
#
#   ./scripts/check.sh
#
# Нужны: CLI харнесса (npm install --global @deepseek-ai/dsh) и bwrap.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export DSH_HOME="$root/.dsh-test"
profiles="$DSH_HOME/profiles"
src="$root/packages/@rkfg/dsh-sandbox-allowlist/lib"
ui="$root/packages/@rkfg/dsh-sandbox-allowlist-ui"

command -v dsh >/dev/null || { echo "нужен CLI харнесса: npm install --global @deepseek-ai/dsh" >&2; exit 1; }
command -v bwrap >/dev/null || { echo "нужен bubblewrap (bwrap) для confinement-проверок" >&2; exit 1; }

echo "### синтаксис"
bash "$root/scripts/lint.sh" && echo "ок"

echo
echo "### манифесты и ссылки patch-слоёв"
python3 - "$root" <<'META'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
max_icon = 256 * 1024
problems = []
for pkg in ('@rkfg/dsh-sandbox-allowlist', '@rkfg/dsh-sandbox-allowlist-ui'):
    box = root / 'packages' / pkg
    data = json.loads((box / 'package.json').read_text())
    exports = data.get('exports', {})
    for key in ('./package.json', './locale/*.json'):
        if key not in exports:
            problems.append(f'{pkg}: нет ключа exports {key}')
    for lang in ('en', 'zh'):
        path = box / 'locale' / f'{lang}.json'
        if not path.is_file():
            problems.append(f'{pkg}: нет locale/{lang}.json')
            continue
        meta = json.loads(path.read_text()).get('meta', {})
        for field in ('title', 'description'):
            value = meta.get(field)
            if not isinstance(value, str) or not value.strip():
                problems.append(f'{pkg}: locale/{lang}.json поле meta.{field} пустое')
    icon = data.get('icon')
    if icon:
        if not isinstance(icon, str) or icon.startswith(('/', 'http')) or '..' in icon:
            problems.append(f'{pkg}: недопустимый путь иконки {icon!r}')
        else:
            target = (box / icon).resolve()
            if not str(target).startswith(str(box.resolve())):
                problems.append(f'{pkg}: иконка вне пакета: {icon}')
            elif target.suffix.lower() not in ('.svg', '.png', '.jpg', '.jpeg', '.webp'):
                problems.append(f'{pkg}: неподдерживаемый формат иконки {icon}')
            elif not target.is_file():
                problems.append(f'{pkg}: файл иконки не найден: {icon}')
            elif target.stat().st_size > max_icon:
                problems.append(f'{pkg}: иконка больше 256 КиБ: {icon}')
    files = set(data.get('files', []))
    for needed in ('locale', 'icon.svg'):
        if needed not in files:
            problems.append(f'{pkg}: в files нет {needed}')
    patch = box / 'cordis.patch.yml'
    prefix = data['name'] + '/'
    for name in set(re.findall(r'name:\s*([\w@/-]+)', patch.read_text())):
        if not name.startswith(prefix):
            continue
        key = './' + name[len(prefix):]
        target = exports.get(key)
        if target is None:
            problems.append(f'{pkg}: patch ссылается на {key}, а в exports нет')
        elif not (box / target).is_file():
            problems.append(f'{pkg}: {key} → {target}: файла нет')
print('проблем нет' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
META
manifest_status=$?

echo
echo "### YAML patch-слоёв"
python3 - "$root" <<'YAML'
import pathlib, sys
import yaml
root = pathlib.Path(sys.argv[1])
problems = []
for pkg in ('@rkfg/dsh-sandbox-allowlist', '@rkfg/dsh-sandbox-allowlist-ui'):
    path = root / 'packages' / pkg / 'cordis.patch.yml'
    try:
        rows = yaml.safe_load(path.read_text())
        if not isinstance(rows, list) or not rows:
            problems.append(f'{pkg}: patch-слой пуст или не список')
    except Exception as error:
        problems.append(f'{pkg}: {error}')
print('проблем нет' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
YAML
[[ $? -eq 0 ]] || manifest_status=1

# --- профили контура: собираются заново при каждом прогоне ---
make_profile() {
  local name=$1
  shift
  local dir="$profiles/$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  echo '[]' > "$dir/cordis.yml"
  local bundles
  bundles=$(printf '"%s",' "$@" | sed 's/,$//')
  printf '{\n  "name": "dsh-profile-%s",\n  "private": true,\n  "dependencies": {},\n  "dsh": { "profile": { "bundles": [%s] } }\n}\n' "$name" "$bundles" > "$dir/package.json"
}

make_profile basetest '@deepseek-ai/dsh-base' '@deepseek-ai/dsh-headless'
make_profile allowtest '@deepseek-ai/dsh-base' '@deepseek-ai/dsh-headless'

# Модули плагина кладутся в папку профиля: контур проверяет строки провайдера,
# а форму бандла проверяет scripts/webfull.sh.
for prof in basetest allowtest; do
  mkdir -p "$profiles/$prof/sandbox-allowlist"
  printf '{"type":"module"}\n' > "$profiles/$prof/sandbox-allowlist/package.json"
  cp -f "$src"/*.js "$profiles/$prof/sandbox-allowlist/"
  cp -f "$root/test/driver.js" "$profiles/$prof/sandbox-allowlist/"
done

# basetest: тот же драйвер против базовых провайдеров харнесса — без строк плагина.
cat > "$profiles/basetest/cordis.patch.yml" <<PATCH
- insert:
    - id: sandbox-allowlist-driver
      name: ./sandbox-allowlist/driver.js
PATCH

mkdir -p "$DSH_HOME/allowed" "$DSH_HOME/denied" "$DSH_HOME/run"

cat > "$profiles/allowtest/cordis.patch.yml" <<PATCH
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
  disabled: true
- insert:
    - id: subprocess-guard
      name: ./sandbox-allowlist/subprocess.js
    - id: sandbox-guard-api
      name: ./sandbox-allowlist/guard-api.js
    - id: sandbox-allowlist
      name: ./sandbox-allowlist/allowlist.js
      config:
        writableDirs:
          - ./relative-must-be-skipped
          - $DSH_HOME/allowed
        readDenyDirs:
          - $DSH_HOME/run/secretdir
        readDenyFiles:
          - $DSH_HOME/secretfile.txt
          - $DSH_HOME/run/../nonexistent-secret
    - id: fs-allowlist
      name: ./sandbox-allowlist/fs.js
    - id: sandbox-allowlist-runner
      name: ./sandbox-allowlist/runner.js
    - id: sandbox-allowlist-driver
      name: ./sandbox-allowlist/driver.js
PATCH

run_profile() {
  (cd "$DSH_HOME/run" && timeout "${DSH_TEST_TIMEOUT:-90}" dsh --profile "$1" 2>/dev/null) | sed -n '/==== RESULT/,/================/p'
}

echo
echo "### basetest: базовые провайдеры (ожидаем DENIED в allowed и в .git)"
run_profile basetest

echo
echo "### allowtest: с плагином (ожидаем WROTE в allowed, DENIED в denied и .git)"
run_profile allowtest

exit $manifest_status
