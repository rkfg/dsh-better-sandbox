#!/usr/bin/env bash
# Main verification contour: the same driver is run against the harness' built-in
# providers and against the plugin. Everything stays inside the repository: DSH_HOME
# points at .dsh-test, nothing is written outside the repo, and the main profile is
# left alone.
#
#   ./scripts/check.sh
#
# Requires: the pinned dependency tree of this workspace (`npm ci`) and bwrap.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export DSH_HOME="$root/.dsh-test"
profiles="$DSH_HOME/profiles"
src="$root/packages/@rkfg/dsh-better-sandbox/lib"
ui="$root/packages/@rkfg/dsh-better-sandbox-ui"

# The contour runs the harness CLI this workspace pins — the copy the lockfile fixed, not
# whatever version happens to be installed globally.
export PATH="$root/node_modules/.bin:$PATH"
command -v dsh >/dev/null || { echo "the harness CLI is required: run npm ci in $root (it installs the pinned @deepseek-ai/dsh)" >&2; exit 1; }
command -v bwrap >/dev/null || { echo "bubblewrap (bwrap) is required for the confinement checks" >&2; exit 1; }
# Installed is not the same as usable: the contour asserts the mounts bwrap makes, and a
# host that refuses an unprivileged user namespace runs the commands under landlock, where
# read masks and protected names cannot apply. One clear refusal beats a wall of missing
# expectations — and the plugin reports that host as a guard gap, exactly as designed.
if ! bwrap --dev-bind / / true 2>/dev/null; then
  echo "bwrap cannot create a user namespace here, so the confinement checks cannot run on this host" >&2
  exit 1
fi

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

# A paragraph between the header separator and the body rows silently splits a
# Markdown table in two, and the rows then render as plain text.
echo
echo "### markdown tables"
python3 - "$root" <<'TABLE'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
skip = {'.git', '.dsh-test', 'node_modules'}
separator = re.compile(r'^\|[\s:|-]+\|$')
problems = []
for path in sorted(root.rglob('*.md')):
    if skip & set(path.parts):
        continue
    lines = path.read_text().splitlines()
    start = None
    for number in range(len(lines) + 1):
        row = number < len(lines) and lines[number].lstrip().startswith('|')
        if row and start is None:
            start = number
        elif not row and start is not None:
            block = lines[start:number]
            if len(block) < 2 or not separator.match(block[1].strip()):
                problems.append(f'{path.relative_to(root)}:{start + 1}: a table block needs its header and separator')
            start = None
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
TABLE
table_status=$?

# The Russian docs address the reader with the plural form and use the same terms
# as the code. The word forms below slipped in once; they are listed here escaped,
# so this file stays English.
echo
echo "### russian wording"
python3 - "$root" <<'WORDS'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
skip = {'.git', '.dsh-test', 'node_modules'}
forbidden = [
    (re.compile(r'\b\u043a\u043e\u0440\u043e\u0431\u043a', re.I), 'a delivered unit is a package here: use the neutral Russian term'),
    (re.compile(r'\b\u043d\u0443\u043b\u0451\u0432', re.I), 'the mask sources are stubs: use the neutral Russian term'),
    (re.compile(r'\b\u0437\u0430\u043f\u0438\u043d', re.I), 'say that the versions are fixed, in neutral Russian'),
    (re.compile(r'\b\u0448\u0430\u0440\u044b\b', re.I), 'say "mounted network shares", in neutral Russian'),
    (re.compile(r'\b\u0448\u0430\u0440\u0430\b', re.I), 'say "mounted network shares", in neutral Russian'),
    (re.compile(r'\b\u0448\u0430\u0440\u043e\u0432\b', re.I), 'say "mounted network shares", in neutral Russian'),
    (re.compile(r'\b\u0437\u0432\u0430\u0442\u044c\b', re.I), 'say "invoke", in neutral Russian'),
    (re.compile(r'\b\u0437\u043e\u0432\u0443\u0442\b', re.I), 'say "call", in neutral Russian'),
    (re.compile(r'\b\u0442\u044b\b', re.I), 'informal address: address the reader with the plural form'),
    (re.compile(r'\b\u0442\u0432\u043e\u0439\b', re.I), 'informal address: address the reader with the plural form'),
    (re.compile(r'\b\u0442\u0432\u043e\u044f\b', re.I), 'informal address: address the reader with the plural form'),
    (re.compile(r'\b\u0442\u0435\u0431\u044f\b', re.I), 'informal address: address the reader with the plural form'),
    (re.compile(r'\b\u0432\u044b\u0431\u0438\u0440\u0430\u0439\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u0434\u043e\u0431\u0430\u0432\u044c\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u0441\u043e\u0437\u0434\u0430\u0439\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u043f\u0440\u043e\u0432\u0435\u0440\u044c\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u043e\u0442\u043a\u0440\u043e\u0439\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u043d\u0430\u0436\u043c\u0438\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u0447\u0438\u0442\u0430\u0439\b', re.I), 'imperative is informal: use the plural form'),
    (re.compile(r'\b\u0441\u043c\u043e\u0442\u0440\u0438\b', re.I), 'imperative is informal: use the plural form'),
]
problems = []
for path in sorted(root.rglob('*.ru.md')):
    if skip & set(path.parts):
        continue
    for number, line in enumerate(path.read_text().splitlines(), 1):
        for pattern, why in forbidden:
            if pattern.search(line):
                problems.append(f'{path.relative_to(root)}:{number}: {why}: {line.strip()[:60]}')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
WORDS
russian_status=$?

# `npm publish --workspace <name>` only finds a package when the root workspaces
# glob reaches it, so a moved directory has to stay inside the glob.
echo
echo "### workspace wiring"
python3 - "$root" <<'WS'
import glob, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
patterns = json.loads((root / 'package.json').read_text()).get('workspaces', [])
covered = {str(pathlib.Path(m).resolve()) for pattern in patterns for m in glob.glob(str(root / pattern))}
found = {str(path.parent.resolve()): path.parent.name for path in root.glob('packages/**/package.json')}
problems = []
for directory, name in sorted(found.items()):
    if directory not in covered:
        problems.append(f'{pathlib.Path(directory).relative_to(root)} ({name}) is outside the workspaces globs {patterns}')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
WS
workspace_status=$?

# The harness family is versioned per package: cordis, cosmokit and schemastery
# carry their own numbers, only dsh-* follow the harness release. A pin copied
# from the harness version does not exist in the registry, and `dsh plugin add`
# fails with ERR_PNPM_NO_MATCHING_VERSION. Every imported package must also be
# declared by the package that imports it.
echo
echo "### dependency pins"
python3 - "$root" <<'DEPS'
import json, pathlib, re, subprocess, sys
root = pathlib.Path(sys.argv[1])
imported = re.compile(r"from '(@deepseek-ai/[a-z-]+)'")
problems, notes = [], []
cache = {}


def published(name, version):
    if (name, version) in cache:
        return cache[(name, version)]
    result = subprocess.run(['npm', 'view', name, 'versions', '--json'], capture_output=True, text=True)
    if result.returncode != 0:
        cache[(name, version)] = None
        return None
    try:
        versions = json.loads(result.stdout)
    except json.JSONDecodeError:
        cache[(name, version)] = None
        return None
    versions = versions if isinstance(versions, list) else [versions]
    cache[(name, version)] = version in versions
    return cache[(name, version)]


for pkg in ('@rkfg/dsh-better-sandbox', '@rkfg/dsh-better-sandbox-ui'):
    box = root / 'packages' / pkg
    declared = json.loads((box / 'package.json').read_text()).get('dependencies', {})
    used = set()
    for source in list(box.glob('*.js')) + list((box / 'lib').glob('*.js')):
        used |= set(imported.findall(source.read_text()))
    for name in sorted(used - set(declared)):
        problems.append(f'{pkg}: imports {name} but does not declare it')
    for name, version in sorted(declared.items()):
        answer = published(name, version)
        if answer is None:
            notes.append(f'{pkg}: {name}@{version} not checked (registry unavailable)')
        elif not answer:
            problems.append(f'{pkg}: {name}@{version} does not exist in the registry')
for note in notes:
    print(f'note: {note}')
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
DEPS
dependency_status=$?

echo
echo "### manifests and patch-layer references"
python3 - "$root" <<'META'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
max_icon = 256 * 1024
problems = []
for pkg in ('@rkfg/dsh-better-sandbox', '@rkfg/dsh-better-sandbox-ui'):
    pkgdir = root / 'packages' / pkg
    data = json.loads((pkgdir / 'package.json').read_text())
    exports = data.get('exports', {})
    for key in ('./package.json', './locale/*.json'):
        if key not in exports:
            problems.append(f'{pkg}: missing exports key {key}')
    for lang in ('en', 'zh'):
        path = pkgdir / 'locale' / f'{lang}.json'
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
            target = (pkgdir / icon).resolve()
            if not str(target).startswith(str(pkgdir.resolve())):
                problems.append(f'{pkg}: icon outside the package: {icon}')
            elif target.suffix.lower() not in ('.svg', '.png', '.jpg', '.jpeg', '.webp'):
                problems.append(f'{pkg}: unsupported icon format {icon}')
            elif not target.is_file():
                problems.append(f'{pkg}: icon file not found: {icon}')
            elif target.stat().st_size > max_icon:
                problems.append(f'{pkg}: icon larger than 256 KiB: {icon}')
    client_js = pkgdir / 'client.js'
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
    patch = pkgdir / 'cordis.patch.yml'
    prefix = data['name'] + '/'
    for name in set(re.findall(r'name:\s*([\w@/-]+)', patch.read_text())):
        if not name.startswith(prefix):
            continue
        key = './' + name[len(prefix):]
        target = exports.get(key)
        if target is None:
            problems.append(f'{pkg}: the patch references {key}, but exports has no such key')
        elif not (pkgdir / target).is_file():
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
for pkg in ('@rkfg/dsh-better-sandbox', '@rkfg/dsh-better-sandbox-ui'):
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
make_profile lifetest '@deepseek-ai/dsh-base' '@deepseek-ai/dsh-headless'

# The plugin modules are copied into the profile folder: this contour checks the provider
# entries, while scripts/webfull.sh checks the bundle form.
for prof in basetest allowtest lifetest; do
  mkdir -p "$profiles/$prof/better-sandbox"
  printf '{"type":"module"}\n' > "$profiles/$prof/better-sandbox/package.json"
  cp -f "$src"/*.js "$profiles/$prof/better-sandbox/"
  cp -f "$root/test/driver.js" "$profiles/$prof/better-sandbox/"
  cp -f "$root/test/lifecycle-probe.js" "$profiles/$prof/better-sandbox/"
done

# basetest: the same driver against the harness' built-in providers — no plugin entries.
cat > "$profiles/basetest/cordis.patch.yml" <<PATCH
- insert:
    - id: better-sandbox-driver
      name: ./better-sandbox/driver.js
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
    - id: better-sandbox-subprocess
      name: ./better-sandbox/subprocess.js
    - id: better-sandbox-guard
      name: ./better-sandbox/guard-api.js
    - id: better-sandbox
      name: ./better-sandbox/rules.js
      config:
        writableDirs:
          - ./relative-must-be-skipped
          - ~/.cache
          # hostile on purpose: a ~/… spelling that walks back out of the home directory
          - ~/../..
          # hostile on purpose: a grant inside a read-protected directory — the read rule
          # wins, and the grant has to be refused by name rather than silently opening the path
          - $DSH_HOME/run/secretdir/sub
          - ~/.dsh-probe-missing
          - $DSH_HOME/allowed
          # hostile on purpose: the whole filesystem, and a grant over the folder holding
          # the mask stubs — both have to be refused by the host, not only by the form
          - /
          - $profiles/allowtest/better-sandbox/.mask
        readDenyDirs:
          - $DSH_HOME/run/secretdir
          # hostile on purpose: a mask over the working directory protects nothing
          - $DSH_HOME/run
        denyScanRoots:
          # the repository under run/deep sits below denyDepth; naming it here is what
          # brings it back under protection without raising the depth for every root
          - $DSH_HOME/run/deep
        denySegments:
          - .git
          - nested/.git
        readDenyFiles:
          - $DSH_HOME/secretfile.txt
          - $DSH_HOME/run/../nonexistent-secret
        segmentLevel: write-segment
    - id: better-sandbox-escalation
      name: ./better-sandbox/escalation.js
    - id: better-sandbox-fs
      name: ./better-sandbox/fs.js
    - id: better-sandbox-runner
      name: ./better-sandbox/runner.js
    - id: better-sandbox-driver
      name: ./better-sandbox/driver.js
PATCH

# lifetest: the mask owner against a confinement that was accepted while the row is being
# unloaded. The probe drives the real entries inside a private cordis context, so this
# profile mounts no plugin rows of its own and races nothing but itself.
cat > "$profiles/lifetest/cordis.patch.yml" <<PATCH
- insert:
    - id: better-sandbox-lifecycle
      name: ./better-sandbox/lifecycle-probe.js
PATCH

run_profile() {
  local name=$1
  # The driver declares the plugin services as dependencies only in the profile that has
  # them, so cordis activates the plugin before the driver instead of racing it.
  local plugin=${2:-0}
  (cd "$DSH_HOME/run" && BETTER_SANDBOX_DRIVER_PLUGIN="$plugin" timeout "${DSH_TEST_TIMEOUT:-90}" dsh --profile "$name" 2>/dev/null) | sed -n '/==== RESULT/,/================/p'
}

echo
echo "### basetest: built-in providers (expect DENIED in allowed and in .git)"
run_profile basetest

echo
echo "### allowtest: with the plugin (expect WROTE in allowed, DENIED in denied and .git; the (level) cases expect WROTE in .git and DENIED outside the workspace)"
run_profile allowtest 1 | tee "$DSH_HOME/allowtest.txt"

echo
echo "### lifetest: unloading the rule owner against an accepted confinement"
run_profile lifetest | tee "$DSH_HOME/lifecycle.txt"

# The dump above is for the eye; the list below is what makes the contour red or green.
# Every expectation is a line the driver has to print, so a silent regression in a provider
# cannot pass by nobody noticing the output changed.
echo
echo "### expectations"
python3 - "$DSH_HOME/allowtest.txt" "$DSH_HOME/lifecycle.txt" <<'EXPECT'
import pathlib, sys
text = '\n'.join(pathlib.Path(path).read_text() for path in sys.argv[1:3])
must = [
    'fs write inside-cwd: WROTE',
    'fs write .git: DENIED FS_SANDBOX_DENIED',
    'fs write allowed dir: WROTE',
    'fs write denied dir: DENIED FS_SANDBOX_DENIED',
    'fs write .git (level): WROTE',
    'fs write denied dir (level): DENIED FS_SANDBOX_DENIED',
    'fs read secret file in dir: DENIED FS_SANDBOX_DENIED',
    'fs list secret dir: DENIED FS_SANDBOX_DENIED',
    'fs watch on secret dir: DENIED FS_SANDBOX_DENIED',
    'bash cat secret file in dir: exit=1 denial-signature=true',
    'bash cat secret file: exit=1 denial-signature=true',
    # a ~/… spelling that walks back out of the home directory resolves to the filesystem
    # root, and the root is refused like a literal /
    '"entry":"~/../..","reason":"root"',
    'grant inside a read-protected path refused: true (still granted: false)',
    # the mask refuses the same file named differently; only the wider dialect calls that a
    # policy refusal, which is the documented trade of `readDenialSignature: paths`
    'bash cat secret file (other spelling): exit=1 denial-signature=false',
    'validate covers-workspace: covers-workspace',
    'the level is offered from: ["workspace-write"]',
    # a stub replaced by a symlink must neither leak nor survive
    'stub replaced with a symlink: symlink=true',
    'command through the replaced stub: exit=1 leaked=false',
    'stub rebuilt by the check: directory=true mode=0',
    'mask self-healing: exists=true',
    # rules that cross a boundary are refused, in the effective lists and in the form
    'no grant for the filesystem root: true',
    'no grant inside the plugin folder',
    # a protection the user configured must not be silently absent in a healthy contour
    'guard gaps: []',
    'deep repository bound (denyScanRoots names it): true',
    'install risk (plugin inside the working root): ""',
    'rules from config are visible right away: true',
    # the mask owner outlives the confinement it accepted, and nothing rebuilds the
    # stubs after its disposer ran
    'plain unload: stubs before=yes, after=gone',
    'confine accepted during unload: confine=ok, secret masked by the stub=yes, stubs after disposal=gone',
    'unload waits for an admitted confinement: stubs while held=kept, after release=gone',
    'after unload: maskUsable=false, stubs recreated=no',
    'lifecycle: OK',
]
must_in_one_line = [
    ['refused by the lists:', 'writableDirs:root'],
    ['refused by the lists:', 'writableDirs:inside-harness'],
    ['refused by the lists:', 'readDenyDirs:covers-workspace'],
    ['validate of "/":', '"root"'],
]
forbidden = ['command through the replaced stub: exit=0', 'leaked=true', 'fs watch on secret dir: WATCH ALLOWED', 'lifecycle: FAILED', 'stubs after disposal=LEFT', 'stubs recreated=yes', 'gone too early', 'secret masked by the stub=no']
problems = [f'missing: {line}' for line in must if line not in text]
problems += [f'missing pair {pair} on one line' for pair in must_in_one_line if not any(all(part in line for part in pair) for line in text.splitlines())]
problems += [f'present but must not be: {line}' for line in forbidden if line in text]
print('no problems' if not problems else '\n'.join(problems))
sys.exit(1 if problems else 0)
EXPECT
expect_status=$?

exit $((manifest_status || language_status || table_status || russian_status || workspace_status || dependency_status || expect_status))

