/**
 * Общие правила «куда писать нельзя» для плагина sandbox-allowlist.
 *
 * Отказ выражается тем же кодом FS_SANDBOX_DENIED, что и штатная песочница,
 * поэтому инструмент write/edit получает стандартный маркер
 * `[sandbox: file access denied …]` вместе с подсказкой про эскалацию, а bash
 * получает его через denial-сигнатуру раннера («read-only file system»).
 *
 * @module dsh-sandbox-allowlist/policy
 */
import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

export const canonical = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Канонический корень существует и является директорией. */
export const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Найти защищённые записи под корнем: любой файл/каталог с именем из `segments`,
 * на глубине не больше `depth`. Обход ограниченный и дешёвый, результат
 * кэшируется на `ttlMs`, потому что confine() вызывается на каждую команду.
 */
export const findProtectedUnder = (root, segments, depth, skipDirs, ttlMs, cache) => {
  const hit = cache.get(root)
  if (hit !== void 0 && Date.now() - hit.at < ttlMs) return hit.paths
  const found = []
  const walk = (dir, level) => {
    if (level > depth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (segments.includes(entry.name)) {
        found.push(canonical(path))
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !skipDirs.includes(entry.name)) walk(path, level + 1)
    }
  }
  if (isDirectory(root)) walk(root, 1)
  const paths = [...new Set(found)].filter((path) => existsSync(path))
  cache.set(root, { at: Date.now(), paths })
  return paths
}

/**
 * Попадает ли канонический путь под защиту по имени компонента. Сравнивается по
 * сегментам, поэтому `.gitignore` не задевает, а `.git/…` и `.git` (gitfile
 * worktree/submodule) — задевает.
 */
export const segmentDenied = (targetPath, segments) => {
  const comparable = targetPath.split(sep)
  for (const segment of comparable) if (segments.includes(segment)) return segment
  return void 0
}
