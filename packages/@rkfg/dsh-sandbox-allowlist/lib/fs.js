/**
 * sandbox-allowlist / fs: расширение песочницы файловой системы.
 *
 * Наследует SandboxedFileSystem (всю механику LocalFileSystem) и меняет решение
 * о цели операции:
 *   запись  — сначала защита по именам (`denySegments`), затем дополнительные
 *             корни, затем базовый containment;
 *   чтение  — отказ по путям из `readDenyDirs` / `readDenyFiles`. Харнесс
 *             забор на чтении не ставит вовсе (`read` разрешён в любом режиме),
 *             поэтому отказ выдаётся тем же кодом FS_SANDBOX_DENIED: инструменты
 *             показывают штатный `[sandbox: …]` и подсказку про эскалацию.
 * danger-full-access — как в харнессе, без забора: туда ведёт эскалация, и она
 * снимает защиту осознанно, по approve пользователя.
 *
 * @module dsh-sandbox-allowlist/fs
 */
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const isUnder = (path, root) => {
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

export default class AllowlistedFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy', 'sandboxAllowlist']

  get allow() {
    return this.ctx.sandboxAllowlist
  }

  get readGuarded() {
    return this.allow.readDirs.length > 0 || this.allow.readFiles.length > 0
  }

  denyRead(displayPath, key, operation, allowDirRoot = true) {
    const protectedBy = this.allow.readDeniedFor(key, allowDirRoot)
    if (protectedBy === void 0) return
    // Для write/edit инструмент сам подставляет маркер и подсказку; для чтения
    // он этого не делает, поэтому текст собирается здесь теми же помощниками.
    throw new FsError(
      [
        sandboxDenialMarker('workspace-write'),
        escalationHintMarker('operation'),
        `cannot ${operation} "${displayPath}": "${protectedBy}" is protected from reading by the sandbox-allowlist policy`,
      ].join('\n'),
      'FS_SANDBOX_DENIED',
    )
  }

  /** lstat намеренно path-образный (не follow symlink) — нормализуем сами. */
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
    if (policy.mode === 'workspace-write' && (allow.roots.length > 0 || allow.denySegments.length > 0)) {
      const fresh = await this.resolve(target.displayPath)
      const denied = allow.deniedSegment(fresh.targetKey)
      if (denied !== void 0) {
        throw new FsError(
          `cannot write "${target.displayPath}": "${denied}" is protected by the sandbox-allowlist policy`,
          'FS_SANDBOX_DENIED',
        )
      }
      for (const root of allow.roots) if (isUnder(fresh.targetKey, root)) return fresh
    }
    return super.checkedTarget(target, sandboxPolicy)
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
