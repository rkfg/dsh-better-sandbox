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
        sandboxDenialMarker('workspace-write'),
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
      const denied = escalated ? void 0 : allow.deniedSegment(fresh.targetKey)
      if (denied !== void 0) {
        throw new FsError(
          `cannot write "${target.displayPath}": "${denied}" is protected by the better-sandbox policy`,
          'FS_SANDBOX_DENIED',
        )
      }
      for (const root of allow.roots) if (isUnder(fresh.targetKey, root)) return fresh
    }
    return super.checkedTarget(target, base)
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
