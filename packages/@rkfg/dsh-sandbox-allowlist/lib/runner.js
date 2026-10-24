/**
 * sandbox-allowlist / sandbox: an extension of child-process confinement.
 *
 * Takes the ready argv from LocalSandboxProvider (runner choice, denial signatures and
 * diagnostic rules stay the base ones) and inserts its own arguments before `--`, that
 * is AFTER the workspace bind — bwrap lets later binds override earlier ones.
 * The arguments themselves live in `masks.js`, and the synchronous ripgrep wrapper
 * takes them from there too: two places with different flags would be a hole.
 *
 * Landlock can neither subtract write access from a broader rule nor deny reading a
 * subpath — the protection cannot be expressed there, which a warning reports.
 *
 * @module dsh-sandbox-allowlist/runner
 */
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { basename } from 'node:path'
import { bwrapGuardArgs } from './masks.js'

const detectRunner = (argv) => {
  const program = argv[0] ?? ''
  if (program === 'bwrap') return 'bwrap'
  if (basename(program) === 'landlock-run') return 'landlock'
  return 'unknown'
}

const WARNED_LIMIT = 64

export default class AllowlistSandboxProvider extends LocalSandboxProvider {
  static inject = ['sandboxAllowlist']

  warned = new Set()

  get allow() {
    return this.ctx.sandboxAllowlist
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return
    // The set grows with the number of distinct paths, so it is capped:
    // on overflow a new cycle starts instead of unbounded growth.
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear()
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }

  async confine(argv, policy, signal) {
    const base = await super.confine(argv, policy, signal)
    const allow = this.allow
    const guarded = allow.roots.length > 0 || allow.denySegments.length > 0 || allow.readDirs.length > 0 || allow.readFiles.length > 0
    if (!guarded) return base
    const separator = base.argv.indexOf('--')
    if (separator === -1) return base
    const runner = detectRunner(base.argv)
    if (runner === 'unknown') {
      this.warnOnce(`unknown-${base.argv[0]}`, `sandbox-allowlist: runner ${JSON.stringify(base.argv[0])} gets neither grants nor protection`)
      return base
    }
    if (runner === 'landlock' && (allow.readDirs.length > 0 || allow.readFiles.length > 0 || allow.denySegments.length > 0)) {
      this.warnOnce(
        'landlock-guards',
        'sandbox-allowlist: landlock cannot subtract write access or deny reading a subpath — denySegments and readDeny are not applied for it',
      )
    }
    const result = runner === 'bwrap'
      ? (() => {
          const extra = bwrapGuardArgs(allow, policy, [policy.workspaceRoot, ...allow.roots], (key, message) => this.warnOnce(key, message), policy.mode === 'workspace-write')
          return extra.length === 0 ? base : {
            ...base,
            argv: [...base.argv.slice(0, separator), ...extra, ...base.argv.slice(separator)],
          }
        })()
      : base
    // A read refusal coming from the mask is EACCES ("permission denied"), while the base
    // bwrap signatures only know "read-only file system". Without the addition the bash
    // tool would show an ordinary error instead of a policy denial with an escalation
    // hint.
    if (runner === 'bwrap' && allow.config.readDenialSignature && (allow.readDirs.length > 0 || allow.readFiles.length > 0)) {
      return { ...result, denialSignatures: [...result.denialSignatures, 'permission denied'] }
    }
    return result
  }
}
