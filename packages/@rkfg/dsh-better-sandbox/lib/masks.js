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
import { isUnder } from './policy.js'

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
 * @param report - `{ warn(key, message), issue(key, message), clear(key) }`: the caller logs
 *   a reason once, and the reason stays recorded until a later confinement proves the
 *   protection applies again, so a temporary problem cannot leave a permanent warning behind.
 *   `warn` is a configured protection that is missing; `issue` is a rule that did not install.
 * @param applyWriteGuards - whether to apply grants and read-only returns (only
 *   `workspace-write`); read masks apply under any confinement.
 * @param exemptProtected - skip the read-only returns for the protected path names, which
 *   is what the escalation level means: the names inherit the write access of the root they
 *   live in, and nothing else changes.
 */
export function bwrapGuardArgs(allow, policy, confined, report, applyWriteGuards, exemptProtected = false) {
  const args = []
  if (applyWriteGuards) {
    for (const root of allow.roots) {
      if (!existsSync(root)) {
        report.issue(`missing-${root}`, `better-sandbox: root ${JSON.stringify(root)} does not exist, grant skipped`)
        continue
      }
      report.clear(`missing-${root}`)
      args.push('--bind', root, root)
    }
    if (!exemptProtected) {
      for (const path of allow.protectedUnder(confined)) {
        // The path may have disappeared between the cached scan and the command launch, and
        // bwrap fails outright on a missing source — so it is checked right here.
        if (!existsSync(path)) continue
        args.push('--ro-bind', path, path)
      }
    }
  }
  for (const dir of allow.readDirs) {
    if (!existsSync(dir)) continue
    if (confined.some((root) => isUnder(root, dir))) {
      report.warn(
        `swallow-${dir}`,
        `better-sandbox: a read mask on ${JSON.stringify(dir)} would cover the working directory, so it is skipped — the rule protects nothing while looking as if it did`,
      )
      continue
    }
    report.clear(`swallow-${dir}`)
    if (allow.maskUsable()) {
      report.clear(`nomask-${dir}`)
      args.push('--ro-bind', allow.mask.dir, dir)
    } else if (allow.config.maskFallback !== 'skip') args.push('--tmpfs', dir)
    else report.warn(`nomask-${dir}`, `better-sandbox: no mask stub for ${JSON.stringify(dir)} and the fallback is "skip", so its contents stay readable to commands`)
  }
  for (const file of allow.readFiles) {
    if (!existsSync(file)) continue
    if (allow.maskUsable()) {
      report.clear(`maskfile-${file}`)
      args.push('--ro-bind', allow.mask.file, file)
    } else report.warn(`maskfile-${file}`, `better-sandbox: no mask stub for the file ${JSON.stringify(file)}, so it stays readable to commands`)
  }
  return args
}

/** How to recognize the bundled ripgrep: it is the only program the wrapper confines. */
export const isRipgrep = (program) => {
  if (typeof program !== 'string') return false
  return /(^|[\\/])rg(\.exe)?$/u.test(program) || program.includes('@vscode/ripgrep')
}

/**
 * The extra strings that make a masked read recognizable as a policy refusal.
 *
 * A mask produces `EACCES`, which the base bwrap dialect ("read-only file system", the
 * `EROFS` of the base read-only bind) does not cover; without an addition the model sees an
 * unexplained command failure instead of a refusal with the rule behind it. The consumer
 * matches these as case-insensitive substrings of stderr, and a kernel `EACCES` carries no
 * marker of its own, so `paths` contributes the protected paths themselves: only a failure
 * that names a protected path is reported as a policy refusal, while an unrelated permission
 * error stays an ordinary one. `any` also matches the bare wording, which catches every
 * masked read — including the ones whose message names no path — at the cost of reporting
 * unrelated permission errors as policy denials.
 *
 * @param allow - the betterSandbox service.
 * @returns the signatures to append, possibly empty.
 */
export const readMaskSignatures = (allow) => {
  const mode = allow.readDenialSignature
  if (mode === 'off') return []
  if (mode === 'any') return ['permission denied']
  return [...allow.readDirs, ...allow.readFiles]
}
