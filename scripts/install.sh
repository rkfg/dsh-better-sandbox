#!/usr/bin/env bash
# Installs both packages into the profile and enables them in dsh.profile.bundles.
# The entries themselves are declared in the bundle's patch layer, so the profile's
# cordis.patch.yml only carries the list values.
#
#   ./scripts/install.sh                                  # the web profile
#   ./scripts/install.sh --home <dir> --profile <name>    # another DSH_HOME/profile
#   ./scripts/install.sh --drop <old-name>                # drop an old package name
#
# --drop is needed after a package rename: otherwise the profiles keep the entries
# and folders of the old name, and two packages sharing one package name break the
# page load ("duplicate factory registration").
#
# The regular install is `dsh plugin --profile <name> add @rkfg/dsh-better-sandbox`.
# This script is for installing from a working tree: it checks the syntax, backs up the
# profile's package.json, and re-creates the mask stubs that bwrap takes as source paths.
#
set -euo pipefail
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
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Every path below is built by joining these two, so they are resolved once here, and the
# profile has to be one name: a value carrying a separator would aim the install, and the
# removal of an old package folder, somewhere else entirely.
[[ -d $home ]] || { echo "no such DSH_HOME: $home" >&2; exit 1; }
home=$(cd "$home" && pwd -P)
[[ -n $profile && $profile != */* && $profile != .* ]] || { echo "the profile name is one path segment: $profile" >&2; exit 2; }

src="$root/packages/@rkfg/dsh-better-sandbox"
uipkg="$root/packages/@rkfg/dsh-better-sandbox-ui"
prof="$home/profiles/$profile"
dst="$prof/node_modules/@rkfg/dsh-better-sandbox"
uirst="$prof/node_modules/@rkfg/dsh-better-sandbox-ui"
[[ -d "$prof" ]] || { echo "no such profile: $prof" >&2; exit 1; }

export DROP
DROP=$(printf '%s\n' "${drop[@]:-}" | sed '/^$/d')
bash "$root/scripts/lint.sh" || exit 1

if [[ -e "$dst" ]]; then
  prev=$(node -e 'const p=require(process.argv[1]);console.log(p.version??"")' "$dst/package.json" 2>/dev/null || echo unknown)
  rm -rf "$dst"
  echo "updated a previous installation (version $prev)"
fi
mkdir -p "$prof/node_modules/@rkfg"
cp -r "$src" "$dst"
rm -rf "$dst/lib/.mask"

# The mode-000 mask stubs live in the plugin folder and go to bwrap as source paths:
# without them confine fails for every command ("Can't find source path"), so they are
# created both by the plugin before each command and by the installer right after copying.
mask="$dst/lib/.mask"
mkdir -p "$mask/empty-dir"
: > "$mask/empty-file"
chmod 000 "$mask/empty-dir" "$mask/empty-file"

# The package holding the Settings section is a separate package: a package with a client
# half must own exactly one loader entry.
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
const wanted = ['@rkfg/dsh-better-sandbox', '@rkfg/dsh-better-sandbox-ui']
const dropped = (process.env.DROP ? process.env.DROP.split('\n').filter(Boolean) : [])
// A dropped package folder may still hold the mode-000 mask stubs: rmSync cannot
// descend into them, so they are made writable first (same rule as deleting the
// folder by hand). A stub that is no longer a stub is removed rather than chmodded:
// chmod follows a symlink and would change the mode of whatever the stub was
// replaced with.
const removePackage = (dir) => {
  for (const stub of [`${dir}/lib/.mask/empty-dir`, `${dir}/lib/.mask/empty-file`]) {
    try {
      const info = fs.lstatSync(stub)
      if (info.isSymbolicLink()) fs.rmSync(stub, { force: true })
      else fs.chmodSync(stub, 0o755)
    } catch {}
  }
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}
for (const name of dropped) {
  const index = pkg.dsh.profile.bundles.indexOf(name)
  if (index !== -1) pkg.dsh.profile.bundles.splice(index, 1)
  const removed = removePackage(`${path.dirname(file)}/node_modules/${name}`)
  console.log(`${removed ? 'removed old name' : 'old name already gone'}: ${name}`)
}
const missing = wanted.filter((name) => !pkg.dsh.profile.bundles.includes(name))
if (dropped.length === 0 && missing.length === 0) {
  console.log('both packages are already in bundles')
} else {
  const backup = `${file}.bak-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.writeFileSync(backup, fs.readFileSync(file, 'utf8'))
  pkg.dsh.profile.bundles.push(...missing)
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`added to bundles: ${missing.join(', ')} (backup: ${backup})`)
}
NODE
)" "$prof/package.json"

echo "installed: $dst"
echo "installed: $uirst"
echo "the profile only needs the values: - id: better-sandbox / name: '@rkfg/dsh-better-sandbox/rules' / config: { writableDirs: [...], readDenyDirs: [...], readDenyFiles: [...], denySegments: [...] }"
echo 'a profile restart is required'
