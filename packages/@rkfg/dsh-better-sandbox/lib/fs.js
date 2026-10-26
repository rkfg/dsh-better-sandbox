/**
 * better-sandbox / fs: an extension of the file system sandbox.
 *
 * Extends SandboxedFileSystem (all of the LocalFileSystem mechanics) and only changes
 * how the target of an operation is judged:
 *   write   — name protection first (`denySegments`), then the extra roots,
 *             then the base containment;
 *   read    — refusal for paths from `readDenyDirs` / `readDenyFiles`. The harness
 *             puts no fence on reading at all (`read` is allowed in every mode),
 *             so the refusal is raised with the same FS_SANDBOX_DENIED code: the
 *             tools then show the regular `[sandbox: …]` marker and the escalation hint.
 * An escalated call may carry this plugin's own level token instead of a mode of the
 * harness ladder (`write-segment`): it means `workspace-write` with the protected names
 * let through for this one call, so the token is normalized to a mode the base fence
 * understands and only the name check is skipped.
 * danger-full-access behaves as in the harness — no fence: escalation leads there, and
 * it removes the protection deliberately, on the user's approval.
 *
 * @module dsh-better-sandbox/fs
 */
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const isUnder = (path, root) => {
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

export default class BetterSandboxFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy', 'betterSandbox']

  get allow() {
    return this.ctx.betterSandbox
  }

  get readGuarded() {
    return this.allow.readDirs.length > 0 || this.allow.readFiles.length > 0
  }

  denyRead(displayPath, key, operation, allowDirRoot = true) {
    const protectedBy = this.allow.readDeniedFor(key, allowDirRoot)
    if (protectedBy === void 0) return
    // For write/edit the tool substitutes its own marker and hint; for reading it does
    // not, so the text is assembled here. The hint of the shared vocabulary is left out
    // on purpose: no tool advertises sandbox_permissions for a read, so telling the model
    // to escalate one sends it into a schema error instead of a decision.
    throw new FsError(
      [
        sandboxDenialMarker(this.ctx.sandboxPolicy.resolve().mode),
        `[better-sandbox: "${protectedBy}" is protected from reading by the better-sandbox policy; no escalation opens a read, the user has to change the rule]`,
        `cannot ${operation} "${displayPath}"`,
      ].join('\n'),
      'FS_SANDBOX_DENIED',
    )
  }

  /** lstat is deliberately path-shaped (it does not follow symlinks) — normalize it ourselves. */
  normalizePath(path, opts) {
    const absolute = resolve(opts?.cwd ?? process.cwd(), path)
    try {
      return realpathSync.native(absolute)
    } catch {
      return absolute
    }
  }

  /** Refuse a write whose canonical path lies in a protected entry, or stay silent. */
  protectedName(target, displayPath, escalated) {
    if (escalated || typeof target !== 'string') return
    const denied = this.allow.deniedSegment(target)
    if (denied === void 0) return
    throw new FsError(
      `cannot write "${displayPath}": "${denied}" is protected by the better-sandbox policy`,
      'FS_SANDBOX_DENIED',
    )
  }

  async checkedTarget(target, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const allow = this.allow
    const escalated = allow.isSegmentLevel(policy.mode)
    // The level is `workspace-write` with the protected names let through, so the base
    // fence is handed a mode it knows instead of an unknown token it would treat as
    // "containment against no roots at all".
    const base = escalated ? { ...policy, mode: 'workspace-write' } : policy
    if (base.mode === 'workspace-write' && (allow.roots.length > 0 || allow.denySegments.length > 0)) {
      const fresh = await this.resolve(target.displayPath)
      this.protectedName(fresh.targetKey, target.displayPath, escalated)
      for (const root of allow.roots) if (isUnder(fresh.targetKey, root)) return fresh
    }
    const checked = await super.checkedTarget(target, base)
    // The base fence canonicalizes again immediately before the mutation and returns THAT
    // target — it is the one the write lands on. Checking only the earlier resolve would let
    // an ancestor symlink swapped in between the two decide which name rule applies.
    if (base.mode !== 'danger-full-access') this.protectedName(checked?.targetKey, target.displayPath, escalated)
    return checked
  }

  async stat(target, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'stat', true)
    return super.stat(target, signal)
  }

  async lstat(path, opts, signal) {
    if (this.readGuarded) this.denyRead(path, this.normalizePath(path, opts), 'lstat', true)
    return super.lstat(path, opts, signal)
  }

  async listDir(target, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'list', false)
    return super.listDir(target, signal)
  }

  /**
   * A watcher reports that something changed inside a path, and that report is itself a read
   * of the path: the names and the moments of what lives under a protected directory. The
   * inherited implementation reaches the target through `stat`, which keeps the contents
   * closed, so what is closed here is the watch over the protected directory itself.
   */
  async watch(target, changed, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'watch', false)
    return super.watch(target, changed, signal)
  }

  async readText(target, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'read')
    return super.readText(target, signal)
  }

  async streamText(target, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'stream')
    return super.streamText(target, signal)
  }

  async readBytes(target, signal, maxBytes) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'read')
    return super.readBytes(target, signal, maxBytes)
  }

  async readByteRange(target, range, signal) {
    if (this.readGuarded) this.denyRead(target.displayPath, target.targetKey, 'read')
    return super.readByteRange(target, range, signal)
  }
}
