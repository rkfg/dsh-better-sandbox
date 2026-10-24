/**
 * sandbox-allowlist / sandbox: расширение confinement дочерних процессов.
 *
 * Берёт готовый argv у LocalSandboxProvider (выбор раннера, denial-сигнатуры и
 * правила диагностики остаются базовые) и вставляет свои аргументы перед `--`,
 * то есть ПОСЛЕ привязки workspace — поздние привязки bwrap перекрывают ранние.
 * Сами аргументы живёт в `masks.js`, оттуда же их берёт синхронная обёртка
 * ripgrep: два места с разными флагами были бы дырой.
 *
 * Landlock не умеет ни вычитать запись из более широкого правила, ни запретить
 * чтение подпути — там защита не выражается, о чём пишется предупреждение.
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
    // Множество растёт вместе с числом разных путей, поэтому оно ограничено:
    // при переполнении начинается новый цикл, а не бесконечный рост.
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
      this.warnOnce(`unknown-${base.argv[0]}`, `sandbox-allowlist: раннер ${JSON.stringify(base.argv[0])} не получает ни грантов, ни защиты`)
      return base
    }
    if (runner === 'landlock' && (allow.readDirs.length > 0 || allow.readFiles.length > 0 || allow.denySegments.length > 0)) {
      this.warnOnce(
        'landlock-guards',
        'sandbox-allowlist: landlock не умеет вычитать запись и запрещать чтение подпути — denySegments и readDeny для него не применяются',
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
    // Отказ чтения из маски — это EACCES («permission denied»), а базовые
    // сигнатуры bwrap знают только «read-only file system». Без дополнения
    // инструмент bash показал бы обычную ошибку вместо политического отказа с
    // подсказкой об эскалации.
    if (runner === 'bwrap' && allow.config.readDenialSignature && (allow.readDirs.length > 0 || allow.readFiles.length > 0)) {
      return { ...result, denialSignatures: [...result.denialSignatures, 'permission denied'] }
    }
    return result
  }
}
