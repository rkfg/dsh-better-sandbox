/**
 * sandbox-allowlist / subprocess: confinement for ripgrep.
 *
 * `grep` and `glob` run through the bundled ripgrep via `ctx.subprocess`, and this
 * seam is deliberately not confined — neither the policy fence nor the mask reaches it.
 * The wrapper puts ONLY the ripgrep invocation through bwrap; every other spawn
 * (the harness's git, the terminal, jobs, MCP) goes to the base provider unchanged.
 *
 * The confinement is minimal: read-only mode, working directory — the spawn's cwd.
 * ripgrep has nothing to write, and the readDenyDirs/readDenyFiles masks work under
 * any confinement. The seam is synchronous, so argv is assembled here rather than
 * through `ctx.sandbox.confine` (the shared pieces live in `masks.js`).
 *
 * @module dsh-sandbox-allowlist/subprocess
 */
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { bwrapBaseArgs, bwrapGuardArgs, isRipgrep } from './masks.js'

const WARNED_LIMIT = 64

export default class GuardedSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['sandboxPolicy', 'sandboxAllowlist']

  bwrapUsable
  warned = new Set()

  warnOnce(key, message) {
    if (this.warned.has(key)) return
    // The set grows with the number of distinct paths, so it is capped:
    // on overflow a new cycle starts instead of unbounded growth.
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear()
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }

  /** A functional check done once: without bwrap a wrapped spawn would fail outright. */
  bwrapAvailable() {
    if (this.bwrapUsable === void 0) {
      this.bwrapUsable = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0
      if (!this.bwrapUsable) this.warnOnce('no-bwrap', 'sandbox-allowlist: bwrap is unavailable, ripgrep runs without confinement — read protection for grep/glob does not work')
    }
    return this.bwrapUsable
  }

  spawn(spec) {
    const allow = this.ctx.sandboxAllowlist
    const guarded = allow.readDirs.length > 0 || allow.readFiles.length > 0 || allow.denySegments.length > 0 || allow.roots.length > 0
    if (!guarded || !isRipgrep(spec.argv[0]) || !this.bwrapAvailable()) return super.spawn(spec)
    const policy = { mode: 'read-only', workspaceRoot: spec.cwd }
    const confined = [spec.cwd, ...allow.roots]
    const args = [...bwrapBaseArgs(policy.mode), ...bwrapGuardArgs(allow, policy, confined, (key, message) => this.warnOnce(key, message), false)]
    if (args.length === bwrapBaseArgs(policy.mode).length) return super.spawn(spec)
    this.ctx.logger.debug?.(`sandbox-allowlist: ripgrep under confinement: ${basename(spec.argv[0])} in ${spec.cwd}`)
    return super.spawn({ ...spec, argv: ['bwrap', ...args, '--', ...spec.argv] })
  }
}
