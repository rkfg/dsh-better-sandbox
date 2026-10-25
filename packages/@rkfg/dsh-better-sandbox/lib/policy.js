/**
 * Shared "where writing is forbidden" rules for the better-sandbox plugin.
 *
 * The refusal is expressed with the same FS_SANDBOX_DENIED code as the stock sandbox,
 * so the write/edit tool gets the standard `[sandbox: file access denied …]` marker
 * together with the escalation hint, and bash gets it through the runner's denial
 * signature ("read-only file system").
 *
 * @module dsh-better-sandbox/policy
 */
import { existsSync, realpathSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export const canonical = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` is `root` itself or lies beneath it. The comparison is done on path
 * segments, so a root spelled `/` matches everything while a prefix such as `/home/ab`
 * never matches `/home/abc`.
 *
 * @param path - the path to place.
 * @param root - the candidate ancestor.
 */
export const isUnder = (path, root) => {
  if (path === root) return true
  const rest = relative(root, path)
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

/**
 * Whether a mask stub still has the shape the confinement expects. A stub is the SOURCE
 * of a bind, and a bind follows a symlinked source, so a stub replaced by a link would
 * mount whatever it points at over the protected path — turning a read denial into a read
 * grant. The mode is checked too: a stub that has become writable is no longer the thing
 * that produces the refusal.
 *
 * @param path - the stub to inspect.
 * @param kind - `dir` or `file`, the shape the bind expects.
 * @returns `''` when the stub is intact, otherwise the reason it is not.
 */
export const stubProblem = (path, kind) => {
  if (typeof path !== 'string') return 'missing'
  let info
  try {
    info = lstatSync(path)
  } catch {
    return 'missing'
  }
  if (info.isSymbolicLink()) return 'symlink'
  if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) return kind === 'dir' ? 'not a directory' : 'not a file'
  if ((info.mode & 0o777) !== 0) return `mode ${(info.mode & 0o777).toString(8)}`
  return ''
}

/** How many truncated directories one scan reports: the count is exact, the list is a sample. */
export const TRUNCATED_REPORT_LIMIT = 8

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
 * cached for `ttlMs`, because confine() runs for every command. A `ttlMs` of 0 re-walks
 * on every call, which is what a deployment chooses when a name created moments ago has
 * to be protected by the very next command.
 *
 * The walk also reports where it stopped: a protected name below the depth boundary is
 * silently unprotected otherwise, and the difference is invisible from the configuration.
 *
 * @returns `paths` — the protected entries found; `truncated` — directories whose children
 *   were not examined; `truncatedCount` — how many such directories there were.
 */
export const findProtectedUnder = (root, segments, depth, skipDirs, ttlMs, cache) => {
  const hit = cache.get(root)
  if (hit !== void 0 && Date.now() - hit.at < ttlMs) return hit
  const paths = []
  const truncated = []
  let truncatedCount = 0
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
        paths.push(canonical(path))
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !skipDirs.includes(entry.name)) {
        if (level >= depth) {
          truncatedCount += 1
          if (truncated.length < TRUNCATED_REPORT_LIMIT) truncated.push(path)
          continue
        }
        walk(path, level + 1)
      }
    }
  }
  if (isDirectory(root)) walk(root, 1)
  const found = [...new Set(paths)].filter((path) => existsSync(path))
  const scan = { at: Date.now(), paths: found, truncated, truncatedCount }
  cache.set(root, scan)
  return scan
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
