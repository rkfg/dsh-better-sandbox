/**
 * Shared "where writing is forbidden" rules for the sandbox-allowlist plugin.
 *
 * The refusal is expressed with the same FS_SANDBOX_DENIED code as the stock sandbox,
 * so the write/edit tool gets the standard `[sandbox: file access denied …]` marker
 * together with the escalation hint, and bash gets it through the runner's denial
 * signature ("read-only file system").
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

/** The canonical root exists and is a directory. */
export const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Find protected entries under a root: any file/directory named in `segments`,
 * at a depth of at most `depth`. The walk is bounded and cheap, and the result is
 * cached for `ttlMs`, because confine() runs for every command.
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
 * Whether a canonical path falls under name protection. The comparison is done by
 * segments, so `.gitignore` is not affected, while `.git/…` and `.git` (a gitfile of a
 * worktree/submodule) are.
 */
export const segmentDenied = (targetPath, segments) => {
  const comparable = targetPath.split(sep)
  for (const segment of comparable) if (segments.includes(segment)) return segment
  return void 0
}
