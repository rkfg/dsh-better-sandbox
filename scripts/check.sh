#!/usr/bin/env bash
# Main verification contour: the same driver is run against the harness' built-in
# providers and against the plugin. Everything stays inside the repository: DSH_HOME
# points at .dsh-test, nothing is written outside the repo, and the main profile is
# left alone.
#
#   ./scripts/check.sh
#
# Requires: the harness CLI (npm install --global @deepseek-ai/dsh) and bwrap.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export DSH_HOME="$root/.dsh-test"
profiles="$DSH_HOME/profiles"
src="$root/packages/@rkfg/dsh-sandbox-allowlist/lib"
ui="$root/packages/@rkfg/dsh-sandbox-allowlist-ui"

command -v dsh >/dev/null || { echo "the harness CLI is required: npm install --global @deepseek-ai/dsh" >&2; exit 1; }
command -v bwrap >/dev/null || { echo "bubblewrap (bwrap) is required for the confinement checks" >&2; exit 1; }

echo "### syntax"
bash "$root/scripts/lint.sh" && echo "ok"

# Published code is English: comments, log lines and test output alike. Cyrillic is
# legitimate only in the locale dictionaries and in the Russian README.
echo
echo "### language"
python3 - "$root" <<'LANG'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
skip = {'.git', '.dsh-test', 'node_modules'}
cyrillic = re.compile(r'[\u0400-\u04ff]')
allowed_suffixes = ('.js', '.mjs', '.sh', '.yml', '.yaml', '.json', '.md', '.svg')
problems = []
for path in sorted(root.rglob('*')):
    if not path.is_file() or skip & set(path.parts):
        continue
    if path.name == 'README.ru.md' or 'locale' in path.parts:
        continue
    if path.suffix not in allowed_suffixes:
        continue
    try:
        lines = path.read_text().splitlines()
    except UnicodeDecodeError:
        continue
    for number, line in enumerate(lines, 1):
        if cyrillic.search(line):
            problems.append(f'{path.relative_to(root)}:{number}: {line.strip()[:70]}')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
LANG
language_status=$?

echo
echo "### manifests and patch-layer references"
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
            problems.append(f'{pkg}: missing exports key {key}')
    for lang in ('en', 'zh'):
        path = box / 'locale' / f'{lang}.json'
        if not path.is_file():
            problems.append(f'{pkg}: missing locale/{lang}.json')
            continue
        meta = json.loads(path.read_text()).get('meta', {})
        for field in ('title', 'description'):
            value = meta.get(field)
            if not isinstance(value, str) or not value.strip():
                problems.append(f'{pkg}: locale/{lang}.json field meta.{field} is empty')
    icon = data.get('icon')
    if icon:
        if not isinstance(icon, str) or icon.startswith(('/', 'http')) or '..' in icon:
            problems.append(f'{pkg}: invalid icon path {icon!r}')
        else:
            target = (box / icon).resolve()
            if not str(target).startswith(str(box.resolve())):
                problems.append(f'{pkg}: icon outside the package: {icon}')
            elif target.suffix.lower() not in ('.svg', '.png', '.jpg', '.jpeg', '.webp'):
                problems.append(f'{pkg}: unsupported icon format {icon}')
            elif not target.is_file():
                problems.append(f'{pkg}: icon file not found: {icon}')
            elif target.stat().st_size > max_icon:
                problems.append(f'{pkg}: icon larger than 256 KiB: {icon}')
    client_js = box / 'client.js'
    if client_js.is_file():
        found = re.search(r'__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"', client_js.read_text(), re.S)
        if found is None:
            problems.append(f'{pkg}: client.js has no __ModuleLoader__.load registration with an id')
        elif found.group(1) != data['name']:
            problems.append(f"{pkg}: client module id {found.group(1)!r} does not match the package name {data['name']!r} — the page will not load")
    files = set(data.get('files', []))
    for needed in ('locale', 'icon.svg'):
        if needed not in files:
            problems.append(f'{pkg}: {needed} missing from files')
    patch = box / 'cordis.patch.yml'
    prefix = data['name'] + '/'
    for name in set(re.findall(r'name:\s*([\w@/-]+)', patch.read_text())):
        if not name.startswith(prefix):
            continue
        key = './' + name[len(prefix):]
        target = exports.get(key)
        if target is None:
            problems.append(f'{pkg}: the patch references {key}, but exports has no such key')
        elif not (box / target).is_file():
            problems.append(f'{pkg}: {key} → {target}: file does not exist')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
META
manifest_status=$?

echo
echo "### YAML of the patch layers"
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
            problems.append(f'{pkg}: the patch layer is empty or not a list')
    except Exception as error:
        problems.append(f'{pkg}: {error}')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
YAML
[[ $? -eq 0 ]] || manifest_status=1

# --- contour profiles: rebuilt from scratch on every run ---
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

# The plugin modules are copied into the profile folder: this contour checks the provider
# entries, while scripts/webfull.sh checks the bundle form.
for prof in basetest allowtest; do
  mkdir -p "$profiles/$prof/sandbox-allowlist"
  printf '{"type":"module"}\n' > "$profiles/$prof/sandbox-allowlist/package.json"
  cp -f "$src"/*.js "$profiles/$prof/sandbox-allowlist/"
  cp -f "$root/test/driver.js" "$profiles/$prof/sandbox-allowlist/"
done

# basetest: the same driver against the harness' built-in providers — no plugin entries.
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
          - ~/.cache
          - ~/.dsh-probe-missing
          - $DSH_HOME/allowed
        readDenyDirs:
          - $DSH_HOME/run/secretdir
        denySegments:
          - .git
          - nested/.git
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
echo "### basetest: built-in providers (expect DENIED in allowed and in .git)"
run_profile basetest

echo
echo "### allowtest: with the plugin (expect WROTE in allowed, DENIED in denied and .git)"
run_profile allowtest

exit $((manifest_status || language_status))
