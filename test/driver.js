/**
 * Verification driver: calls the same seams the tools use (ctx.fs.readText /
 * listDir / stat / writeText, ctx.sandbox.confine + spawn) and prints outcomes.
 * A denial that lands in the runner's denial signature is marked separately —
 * only then does the bash tool show the policy marker with the escalation hint.
 *
 * @module dsh-sandbox-allowlist/driver
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'sandbox-allowlist-driver'
export const inject = ['fs', 'sandboxPolicy', 'sandbox', 'subprocess']

const readAll = (handle, stream) => handle.collected?.[stream]?.readFrom(0)?.text ?? ''

const DENIAL_SIGNATURES = ['read-only file system', 'permission denied', 'operation not permitted']

const WRITE_CASES = [
  ['fs write inside-cwd', 'normal/probe.txt'],
  ['fs write .git', '.git/fs-probe.txt'],
  ['fs write allowed dir', '../allowed/fs-probe.txt'],
  ['fs write denied dir', '../denied/fs-probe.txt'],
]

const READ_CASES = [
  ['fs read normal file', 'normal/probe.txt', 'readText', true],
  ['fs read secret file in dir', 'secretdir/id_rsa', 'readText', false],
  ['fs list secret dir', 'secretdir', 'listDir', false],
  ['fs stat secret file', 'secretdir/id_rsa', 'stat', false],
  ['fs read secret file direct', '../secretfile.txt', 'readText', false],
  ['fs read bytes of secret', 'secretdir/id_rsa', 'readBytes', false],
]

const BASH_CASES = [
  ['bash read .git/HEAD', 'cat "$1" >/dev/null'],
  ['bash write into .git', 'printf x > "$2/.git/bash-probe.txt"'],
  ['bash git commit', 'git -C "$2" -c user.email=t@t -c user.name=t commit -m t --allow-empty'],
  ['bash cat secret file in dir', 'cat "$5"'],
  ['bash ls secret dir', 'ls "$6"'],
  ['bash cat secret file', 'cat "$7"'],
  ['bash touch inside secret dir', 'touch "$6/attempt.txt"'],
  ['bash cat normal file', 'cat "$8"'],
]

const RG_CASES = [
  ['rg --files inside secret dir', ['--files', 'secretdir']],
  ['rg search secret content', ['-e', 'SECRET', 'secretdir']],
  ['rg --files cwd (regression)', ['--files', 'normal']],
]

const pathOf = (cwd, rel) => new URL(`file://${cwd}/${rel}`).pathname

export async function apply(ctx) {
  const cwd = process.cwd()
  const allow = ctx.get('sandboxAllowlist')
  const guard = ctx.get('sandboxGuard')
  const policy = ctx.sandboxPolicy.resolve()
  const out = []
  out.push(`policy: mode=${policy.mode} root=${policy.workspaceRoot}`)
  out.push(`write roots: ${JSON.stringify(allow?.roots ?? null)}, denySegments: ${JSON.stringify(allow?.denySegments ?? null)}`)
  out.push(`readDenyDirs: ${JSON.stringify(allow?.readDirs ?? null)}, readDenyFiles: ${JSON.stringify(allow?.readFiles ?? null)}, mask: ${allow?.mask?.available ? '000' : 'fallback'}`)
  out.push(`tilde expanded: ${JSON.stringify((allow?.roots ?? []).filter((root) => root.includes('/.cache')))}, dropped/suspicious: ${JSON.stringify(allow?.rejected ?? null)}`)

  // fixtures: a repository, a nested repository, the "secrets"
  mkdirSync(`${cwd}/normal`, { recursive: true })
  mkdirSync(`${cwd}/secretdir/sub`, { recursive: true })
  writeFileSync(`${cwd}/normal/probe.txt`, 'ordinary content\n')
  writeFileSync(`${cwd}/secretdir/id_rsa`, 'SECRET KEY\n')
  writeFileSync(`${cwd}/secretdir/sub/nested`, 'SECRET IN NESTED\n')
  writeFileSync(`${cwd}/../secretfile.txt`, 'SECRET FILE\n')
  spawnSync('git', ['init', '-q', cwd], { stdio: 'ignore' })
  spawnSync('git', ['init', '-q', `${cwd}/sub`], { stdio: 'ignore' })

  for (const [label, rel] of WRITE_CASES) {
    const path = pathOf(cwd, rel)
    try {
      await ctx.fs.writeText(await ctx.fs.resolve(path), 'ok\n', void 0, void 0, policy)
      out.push(`${label}: WROTE`)
    } catch (error) {
      out.push(`${label}: DENIED ${error.code ?? error.name}`)
    }
  }

  for (const [label, rel, method, expectOk] of READ_CASES) {
    const target = await ctx.fs.resolve(pathOf(cwd, rel))
    try {
      if (method === 'readText') await ctx.fs.readText(target)
      else if (method === 'listDir') await ctx.fs.listDir(target)
      else if (method === 'stat') await ctx.fs.stat(target)
      else await ctx.fs.readBytes(target, void 0, 1024)
      out.push(`${label}: READ${expectOk ? '' : ' (expected a denial!)'}`)
    } catch (error) {
      out.push(`${label}: DENIED ${error.code ?? error.name}`)
    }
  }

  const args = [
    'bash',
    '-c',
    '',
    '_',
    `${cwd}/.git/HEAD`,
    cwd,
    `${cwd}/../allowed/bash-probe.txt`,
    `${cwd}/../denied/bash-probe.txt`,
    `${cwd}/secretdir/id_rsa`,
    `${cwd}/secretdir`,
    `${cwd}/../secretfile.txt`,
    `${cwd}/normal/probe.txt`,
  ]
  for (const [label, spec] of BASH_CASES) {
    args[2] = spec
    const confined = await ctx.sandbox.confine(args, policy)
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', cwd })
    const stderr = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase()
    const signatures = confined.denialSignatures ?? DENIAL_SIGNATURES
    out.push(
      `${label}: exit=${result.status} denial-signature=${signatures.some((signature) => stderr.includes(signature))} :: ${stderr.trim().replace(/\n/g, ' | ').slice(-90)}`,
    )
  }
  // regression: an external process wiped the mask's zero-byte placeholders (as a
  // package reinstall does) — confine must keep working, the mask must restore itself
  const maskDir = allow?.mask?.dir
  if (maskDir === void 0) {
    out.push('no mask was created — mask regression skipped')
  } else {
    // remove the placeholders ourselves: rmdir on a 000 directory needs no access
    // inside it, so this is the same outcome as deleting the whole package folder
    try { chmodSync(maskDir, 0o755) } catch {}
    rmSync(maskDir, { recursive: true, force: true })
    if (allow.mask.file !== void 0) rmSync(allow.mask.file, { force: true })
    out.push(`external removal of the placeholders: mask exists=${existsSync(maskDir)}`)
    const after = [...args]
    after[2] = `touch ${cwd}/.git/post-mask-probe.txt`
    const confined = await ctx.sandbox.confine(after, policy)
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', cwd })
    const stderr = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase()
    out.push(
      `command without the placeholders: exit=${result.status} bwrap-denial=${stderr.includes("can't find source path")} :: ${stderr.trim().replace(/\n/g, ' | ').slice(-80)}`,
    )
    out.push(`mask self-healing: exists=${existsSync(maskDir)}`)
  }

  // the rule checks only make sense when the plugin is attached: basetest runs
  // against the harness's base providers, which simply do not provide them
  if (allow === void 0 || guard === void 0) {
    out.push('plugin not attached: rule checks skipped')
  } else {
    // regression: the effective lists come from config, and the state file must no
    // longer override them (it was exactly what hid the settings-page edit)
    const state = guard.state()
    const expected = String(ctx.sandboxPolicy.workspaceRoot)
    out.push(`sandboxGuard.state(): readDenyDirs=${JSON.stringify(state.readDenyDirs)}, writableDirs=${JSON.stringify(state.writableDirs)}, mask=${state.mask.available ? '000' : state.mask.fallback}`)
    const pluginSidecar = join(dirname(fileURLToPath(import.meta.url)), 'state.json')
    out.push(`state file is not created: ${!existsSync(pluginSidecar)}`)
    const listed = state.readDenyDirs.length > 0 && state.readDenyDirs.some((dir) => dir.endsWith('secretdir'))
    out.push(`rules from config are visible right away: ${listed}`)
    let remoteCode = 'no error'
    try {
      guard.validate('bogus-kind', '/tmp/x')
    } catch (error) {
      remoteCode = `${error.code ?? 'NO CODE'}: ${String(error.message).slice(0, 40)}`
    }
    out.push(`Remote rejection from validate: ${remoteCode}`)
    const rejected = allow.validatePath('readDir', expected)
    out.push(`validate covers-workspace: ${rejected.ok ? 'NOT rejected (expected a denial!)' : rejected.reason}`)

  }

  const rgPath = await (await import('@vscode/ripgrep')).rgPath
  for (const [label, rgArgs] of RG_CASES) {
    const handle = ctx.subprocess.spawn({
      argv: [rgPath, '--no-config', ...rgArgs.map((arg) => (arg === 'secretdir' || arg === 'normal' ? `${cwd}/${arg}` : arg))],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 500,
    })
    const settled = await handle.done
    const text = `${await readAll(handle, 'stdout')}${await readAll(handle, 'stderr')}`
    out.push(`${label}: exit=${settled.exitCode} :: ${text.trim().replace(/\n/g, ' | ').slice(0, 110)}`)
  }
  console.log('\n==== RESULT ====\n' + out.join('\n') + '\n================')
  process.exit(0)
}
