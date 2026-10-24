/**
 * sandbox-allowlist / subprocess: confinement для ripgrep.
 *
 * `grep` и `glob` исполняются упакованным ripgrep через `ctx.subprocess`, и этот
 * seam намеренно без confine — ни policy-fence, ни маска до него не дотягиваются.
 * Обёртка прогоняет через bwrap ТОЛЬКО запуск ripgrep, все остальные спавны
 * (git харнесса, терминал, jobs, MCP) уходят в базовый провайдер без изменений.
 *
 * Confinement минимальный: режим read-only, рабочая директория — cwd спавна.
 * Записывать ripgrep нечего, а маски readDenyDirs/readDenyFiles работают в
 * любом confinement'е. Seam синхронный, поэтому argv собирается здесь, а не
 * через `ctx.sandbox.confine` (общие куски — в `masks.js`).
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
    // Множество растёт вместе с числом разных путей, поэтому оно ограничено:
    // при переполнении начинается новый цикл, а не бесконечный рост.
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear()
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }

  /** Функциональная проверка один раз: без bwrap спавн с обёрткой упал бы целиком. */
  bwrapAvailable() {
    if (this.bwrapUsable === void 0) {
      this.bwrapUsable = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).status === 0
      if (!this.bwrapUsable) this.warnOnce('no-bwrap', 'sandbox-allowlist: bwrap недоступен, ripgrep запускается без confinement — защита чтения для grep/glob не работает')
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
    this.ctx.logger.debug?.(`sandbox-allowlist: ripgrep под confinement'ом: ${basename(spec.argv[0])} в ${spec.cwd}`)
    return super.spawn({ ...spec, argv: ['bwrap', ...args, '--', ...spec.argv] })
  }
}
