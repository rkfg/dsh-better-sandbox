/**
 * better-sandbox / sandbox: an extension of child-process confinement.
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
 * An escalated call carries the plugin's level token as its mode; `confine` normalizes it
 * to `workspace-write` for the base provider and drops the read-only returns over the
 * protected names for that run only (`escalation.js` puts the token in the vocabulary).
 *
 * @module dsh-better-sandbox/runner
 */
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { basename } from 'node:path'
import { bwrapGuardArgs, readMaskSignatures } from './masks.js'

const detectRunner = (argv) => {
  const program = argv[0] ?? ''
  if (program === 'bwrap') return 'bwrap'
  if (basename(program) === 'landlock-run') return 'landlock'
  return 'unknown'
}

const WARNED_LIMIT = 64

export default class BetterSandboxProvider extends LocalSandboxProvider {
  static inject = ['betterSandbox']

  warned = new Set()

  get allow() {
    return this.ctx.betterSandbox
  }

  /** One log line per reason; the reason itself stays recorded until it is cleared. */
  warnOnce(key, message) {
    if (this.warned.has(key)) return
    // The set grows with the number of distinct paths, so it is capped:
    // on overflow a new cycle starts instead of unbounded growth.
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear()
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }

  /**
   * Why a guard was skipped is logged once and kept on the service, where the model is told
   * about it and the settings page shows it. `clear` matters as much as `warn`: a reason that
   * stopped applying must stop warning.
   */
  get report() {
    return {
      warn: (key, message) => {
        this.allow.noteHole(key, message)
        this.warnOnce(key, message)
      },
      issue: (key, message) => {
        this.allow.noteIssue(key, message)
        this.warnOnce(key, message)
      },
      clear: (key) => this.allow.clearGap(key),
    }
  }

  async confine(argv, policy, signal) {
    const allow = this.allow
    // The escalation level is a token of this plugin, not a mode the base provider knows:
    // handed through as-is it would build a profile with no writable root at all. It means
    // `workspace-write` minus the read-only returns over the protected names.
    const escalated = allow.isSegmentLevel(policy.mode)
    const effective = escalated ? { ...policy, mode: 'workspace-write' } : policy
    const base = await super.confine(argv, effective, signal)
    const guarded = allow.roots.length > 0 || allow.denySegments.length > 0 || allow.readDirs.length > 0 || allow.readFiles.length > 0
    if (!guarded) return base
    const separator = base.argv.indexOf('--')
    if (separator === -1) {
      this.report.warn('no-separator', 'better-sandbox: the confinement argv carries no "--" separator, so neither the grants nor the read masks were inserted')
      return base
    }
    this.allow.clearGap('no-separator')
    const runner = detectRunner(base.argv)
    if (runner === 'unknown') {
      this.report.warn('unknown-runner', `better-sandbox: the runner ${JSON.stringify(base.argv[0])} is not recognized, so commands get neither the extra write roots nor the read masks`)
      return base
    }
    this.allow.clearGap('unknown-runner')
    if (runner === 'landlock' && (allow.readDirs.length > 0 || allow.readFiles.length > 0 || allow.denySegments.length > 0)) {
      this.report.warn(
        'landlock-guards',
        'better-sandbox: the landlock runner cannot subtract write access or deny reading a subpath, so denySegments and readDeny do not apply to commands',
      )
    } else this.allow.clearGap('landlock-guards')
    const result = runner === 'bwrap'
      ? (() => {
          const extra = bwrapGuardArgs(
            allow,
            effective,
            [effective.workspaceRoot, ...allow.roots],
            this.report,
            effective.mode === 'workspace-write',
            escalated,
          )
          return extra.length === 0 ? base : {
            ...base,
            argv: [...base.argv.slice(0, separator), ...extra, ...base.argv.slice(separator)],
          }
        })()
      : base
    // A read refusal coming from the mask is EACCES ("permission denied"), while the base
    // bwrap signatures only know "read-only file system". Without the addition the bash
    // tool would show an ordinary error instead of a policy denial with an escalation
    // hint. Which extra strings that is stays a configuration question: see
    // `readMaskSignatures`.
    if (runner === 'bwrap') {
      const extra = readMaskSignatures(allow)
      if (extra.length > 0) return { ...result, denialSignatures: [...result.denialSignatures, ...extra] }
    }
    return result
  }
}
