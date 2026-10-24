/**
 * better-sandbox / bwrap arguments.
 *
 * Single source of truth for what the plugin adds to the bwrap profile: write grants
 * outside the cwd, the read-only return for protected paths, and the masks for the
 * read-protected ones. It has to be a separate module because the `ctx.subprocess`
 * seam is synchronous: the ripgrep wrapper cannot wait for `ctx.sandbox.confine` and
 * builds argv itself, while the bash path goes through the provider and inserts these
 * same pieces into its ready argv. Flags drifting apart here would be a hole.
 *
 * The base bwrap profile is reproduced after `dsh-sandbox-local`
 * (`--ro-bind / /`, `--dev`, `--proc`, `--unshare-pid`, `--die-with-parent`,
 * plus a tmpfs on `/tmp` in workspace-write) — if the harness changes the format,
 * the edit has to be brought here too.
 *
 * @module dsh-better-sandbox/masks
 */
import { existsSync } from 'node:fs'

export const bwrapBaseArgs = (mode) => {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (mode === 'workspace-write') args.push('--tmpfs', '/tmp')
  return args
}

/**
 * The plugin's arguments for one confinement.
 * @param allow - the betterSandbox service.
 * @param policy - the policy allowed for this run.
 * @param confined - roots that must not be covered by a mask (the session cwd and the grants).
 * @param warn - warning callback (the caller emits one call per reason).
 * @param applyWriteGuards - whether to apply grants and read-only returns (only
 *   `workspace-write`); read masks apply under any confinement.
 */
export function bwrapGuardArgs(allow, policy, confined, warn, applyWriteGuards) {
  const args = []
  if (applyWriteGuards) {
    for (const root of allow.roots) {
      if (!existsSync(root)) {
        warn(`missing-${root}`, `better-sandbox: root ${JSON.stringify(root)} does not exist, grant skipped`)
        continue
      }
      args.push('--bind', root, root)
    }
    for (const path of allow.protectedUnder(confined)) {
      // The path may have disappeared between the cached scan and the command launch, and
      // bwrap fails outright on a missing source — so it is checked right here.
      if (!existsSync(path)) continue
      args.push('--ro-bind', path, path)
    }
  }
  for (const dir of allow.readDirs) {
    if (!existsSync(dir)) continue
    if (confined.some((root) => dir === root || root.startsWith(`${dir}/`))) {
      warn(`swallow-${dir}`, `better-sandbox: a read mask on ${JSON.stringify(dir)} would cover the working directory — skipped`)
      continue
    }
    if (allow.maskUsable()) args.push('--ro-bind', allow.mask.dir, dir)
    else if (allow.config.maskFallback !== 'skip') args.push('--tmpfs', dir)
    else warn(`nomask-${dir}`, `better-sandbox: read mask for ${JSON.stringify(dir)} not applied (no stub)`)
  }
  for (const file of allow.readFiles) {
    if (!existsSync(file)) continue
    if (allow.maskUsable()) args.push('--ro-bind', allow.mask.file, file)
    else warn(`maskfile-${file}`, `better-sandbox: read mask for file ${JSON.stringify(file)} not applied (no stub)`)
  }
  return args
}

/** How to recognize the bundled ripgrep: it is the only program the wrapper confines. */
export const isRipgrep = (program) => {
  if (typeof program !== 'string') return false
  return /(^|[\\/])rg(\.exe)?$/u.test(program) || program.includes('@vscode/ripgrep')
}
