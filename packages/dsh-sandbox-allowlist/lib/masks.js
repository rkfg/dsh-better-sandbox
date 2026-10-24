/**
 * sandbox-allowlist / bwrap-аргументы.
 *
 * Один источник истины для того, что плагин добавляет в профиль bwrap: гранты
 * на запись вне cwd, возврат read-only для защищённых путей и маски для
 * защищённых от чтения. Нужен отдельным модулем потому, что seam `ctx.subprocess`
 * синхронный: обёртка ripgrep не может дождаться `ctx.sandbox.confine` и
 * собирает argv сама, а путь bash идёт через провайдер и вставляет эти же куски
 * в его готовый argv. Разъезжающиеся флаги здесь были бы дырой.
 *
 * Базовый профиль bwrap воспроизведён по образцу `dsh-sandbox-local`
 * (`--ro-bind / /`, `--dev`, `--proc`, `--unshare-pid`, `--die-with-parent`,
 * плюс tmpfs на `/tmp` в workspace-write) — при смене формата в харнессе
 * правку надо занести и сюда.
 *
 * @module dsh-sandbox-allowlist/masks
 */
import { existsSync } from 'node:fs'

export const bwrapBaseArgs = (mode) => {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (mode === 'workspace-write') args.push('--tmpfs', '/tmp')
  return args
}

/**
 * Аргументы плагина для одного confinement'а.
 * @param allow - сервис sandboxAllowlist.
 * @param policy - разрешаемая политика этого запуска.
 * @param confined - корни, которые нельзя перекрывать маской (cwd сессии и гранты).
 * @param warn - колбэк предупреждений (один вызов на причину у вызывающего).
 * @param applyWriteGuards - применять ли гранты и read-only возвраты (только
 *   `workspace-write`); маски чтения применяются при любом confinement'е.
 */
export function bwrapGuardArgs(allow, policy, confined, warn, applyWriteGuards) {
  const args = []
  if (applyWriteGuards) {
    for (const root of allow.roots) {
      if (!existsSync(root)) {
        warn(`missing-${root}`, `sandbox-allowlist: корень ${JSON.stringify(root)} не существует, грант пропущен`)
        continue
      }
      args.push('--bind', root, root)
    }
    for (const path of allow.protectedUnder(confined)) {
      // Путь мог исчезнуть между кэшированным обходом и запуском команды, а
      // bwrap на отсутствующем источнике падает целиком — проверяем сейчас.
      if (!existsSync(path)) continue
      args.push('--ro-bind', path, path)
    }
  }
  for (const dir of allow.readDirs) {
    if (!existsSync(dir)) continue
    if (confined.some((root) => dir === root || root.startsWith(`${dir}/`))) {
      warn(`swallow-${dir}`, `sandbox-allowlist: маска чтения на ${JSON.stringify(dir)} перекрывала бы рабочую директорию — пропущено`)
      continue
    }
    if (allow.maskUsable()) args.push('--ro-bind', allow.mask.dir, dir)
    else if (allow.config.maskFallback !== 'skip') args.push('--tmpfs', dir)
    else warn(`nomask-${dir}`, `sandbox-allowlist: маска чтения для ${JSON.stringify(dir)} не применена (нулёвки нет)`)
  }
  for (const file of allow.readFiles) {
    if (!existsSync(file)) continue
    if (allow.maskUsable()) args.push('--ro-bind', allow.mask.file, file)
    else warn(`maskfile-${file}`, `sandbox-allowlist: маска чтения для файла ${JSON.stringify(file)} не применена (нулёвки нет)`)
  }
  return args
}

/** Признак упакованного ripgrep: его и только его обёртка confinement'ит. */
export const isRipgrep = (program) => {
  if (typeof program !== 'string') return false
  return /(^|[\\/])rg(\.exe)?$/u.test(program) || program.includes('@vscode/ripgrep')
}
