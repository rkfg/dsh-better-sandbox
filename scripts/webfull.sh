#!/usr/bin/env bash
# Isolated full web profile (dsh-base + dsh-web-app) for checking the client half and
# live rule editing. Its own DSH_HOME inside the repository, its own port; the main
# profile is left alone.
#
#   ./scripts/webfull.sh                                  # profile entries
#   DSH_BUNDLE=1 ./scripts/webfull.sh                     # bundle form from node_modules
#   DSH_UI=1 …                                            # add the Settings package
#   DSH_PROBE=driver|settings-write|loader …               # add a probe
#   ./scripts/webfull.sh serve                            # keep the server up (for a browser)
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
export DSH_HOME="$root/.dsh-test"
prof="$DSH_HOME/profiles/webfull"
port=${DSH_TEST_PORT:-3181}

rm -rf "$prof"
mkdir -p "$prof" "$DSH_HOME/logs"
echo '[]' > "$prof/cordis.yml"
cp -r "$root/packages/@rkfg/dsh-better-sandbox/lib" "$prof/better-sandbox"
printf '{"type":"module"}\n' > "$prof/better-sandbox/package.json"

if [[ -n ${DSH_UI:-} ]]; then
  mkdir -p "$prof/node_modules/@rkfg"
  cp -r "$root/packages/@rkfg/dsh-better-sandbox-ui" "$prof/node_modules/@rkfg/dsh-better-sandbox-ui"
fi
if [[ -n ${DSH_BUNDLE:-} ]]; then
  mkdir -p "$prof/node_modules/@rkfg"
  cp -r "$root/packages/@rkfg/dsh-better-sandbox" "$prof/node_modules/@rkfg/dsh-better-sandbox"
fi

node - "$prof" "$root" <<'NODE'
const fs = require('fs')
const path = require('path')
const [, , prof, root] = process.argv
const bundle = Boolean(process.env.DSH_BUNDLE)
const probe = process.env.DSH_PROBE ?? ''
const allowed = `${root}/.dsh-test/allowed`
const secret = `${root}/.dsh-test/run/secretdir`

const pkg = {
  name: 'dsh-profile-webfull',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        ...(bundle ? ['@rkfg/dsh-better-sandbox'] : []),
        ...(process.env.DSH_UI ? ['@rkfg/dsh-better-sandbox-ui'] : []),
      ],
    },
  },
}
fs.writeFileSync(path.join(prof, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

const lists = (indent) => [
  `${indent}config:`,
  `${indent}  writableDirs:`,
  `${indent}    - ${allowed}`,
  `${indent}  readDenyDirs:`,
  `${indent}    - ${secret}`,
]

const rows = bundle
  ? [
      '# the entries and the disabling of the built-in providers live in the bundle patch layer,',
      '# only the list values are here (this is how the Settings page writes them).',
      '- id: better-sandbox',
      "  name: '@rkfg/dsh-better-sandbox/rules'",
      ...lists('  '),
    ]
  : [
      '- id: fs-sandbox',
      "  name: '@deepseek-ai/dsh-fs-sandbox'",
      '  disabled: true',
      '- id: sandbox',
      "  name: '@deepseek-ai/dsh-sandbox-local'",
      '  disabled: true',
      '- id: subprocess',
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      '  disabled: true',
      '- insert:',
      '    - id: better-sandbox',
      '      name: ./better-sandbox/rules.js',
      ...lists('      '),
      '    - id: better-sandbox-fs',
      '      name: ./better-sandbox/fs.js',
      '    - id: better-sandbox-runner',
      '      name: ./better-sandbox/runner.js',
      '    - id: better-sandbox-subprocess',
      '      name: ./better-sandbox/subprocess.js',
    ]

const probes = { driver: 'driver', 'settings-write': 'settings-write-probe', 'revision': 'revision-probe', loader: 'loader-probe' }
if (probes[probe] !== void 0) {
  const file = `${probes[probe]}.js`
  fs.copyFileSync(path.join(root, 'test', file), path.join(prof, 'better-sandbox', file))
  rows.push('- insert:', `    - id: ${probes[probe]}`, `      name: ./better-sandbox/${file}`)
}
fs.writeFileSync(path.join(prof, 'cordis.patch.yml'), `${rows.join('\n')}\n`)
NODE

mkdir -p "$DSH_HOME/allowed" "$DSH_HOME/run/secretdir/nested"
echo secret > "$DSH_HOME/run/secretdir/k.txt"
echo secret > "$DSH_HOME/run/secretdir/nested/k2.txt"

if [[ ${1:-} == serve ]]; then
  exec dsh --profile webfull --port "$port" --no-open
fi

log="$DSH_HOME/logs/webfull-boot.log"
(cd "$DSH_HOME/run" && timeout "${DSH_TEST_TIMEOUT:-30}" dsh --profile webfull --port "$port" --no-open) >"$log" 2>&1
echo "=== startup problems ==="
grep -inE "startup failed|did not activate|client-modules|pending \(waiting|failed to import|already declared|Error:" "$log" | head -12
echo "=== total: $(grep -cE 'startup failed|did not activate|failed to import' "$log") problems ==="
