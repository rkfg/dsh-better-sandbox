/**
 * better-sandbox / policy service.
 *
 * Owns one harness file policy, extended in three directions:
 *   writableDirs   — extra roots for WRITING outside the session cwd;
 *   denySegments   — path component names that must not be written (`.git` by default);
 *   readDenyDirs / readDenyFiles — paths that must not be READ (keys, personal data).
 * The lists come from the config of the profile row (cordis.patch.yml).
 *
 * Read protection is two-layered: the policy fence in `fs.js` (a refusal by path for
 * the tools and for every consumer of ctx.fs) and the mask in `runner.js` (a bind of
 * a mode-000 empty directory inside the sandbox, which gives any process EACCES).
 *
 * @module dsh-better-sandbox/rules
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, findProtectedUnder, segmentDenied } from './policy.js'

const pluginDir = dirname(fileURLToPath(import.meta.url))

/**
 * Expands `~` and `~/…` into the home directory. A rule arrives as a string from
 * config or from the settings page, and `resolve()` does not understand a tilde:
 * without this step `~/.cache` silently dropped out of the effective lists.
 *
 * @param entry - a path from config.
 * @returns the path with the tilde expanded; `~user` is not expanded and stays as is.
 */
const expandHome = (entry) => {
  if (entry === '~') return homedir()
  if (entry.startsWith('~/')) return join(homedir(), entry.slice(2))
  return entry
}

/** Paths the harness reads itself: protecting them would make the harness break itself. */
const selfPaths = () => {
  const out = [process.cwd(), pluginDir]
  try {
    const packageDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis/package.json')))
    out.push(dirname(dirname(dirname(packageDir))))
  } catch {}
  return out.map(canonical).filter((path) => isAbsolute(path))
}

export default class BetterSandbox extends Service {
  // needed to check paths (the session boundary) when rules are edited from the UI
  static inject = ['sandboxPolicy']

  // The four rule lists are volatile references: the settings page writes them through
  // ctx.remote.settings, and a running session picks the new value up on the
  // `loader/volatile-update` event without a restart. The config of the profile row
  // only supplies the initial value.
  static Config = z.object({
    writableDirs: z.array(z.string()).default([]).volatile(),
    announceInPrompt: z.boolean().default(true),
    denySegments: z.array(z.string()).default(['.git']).volatile(),
    denyDepth: z.natural().default(3),
    denyScanTtlMs: z.natural().default(10_000),
    denySkipDirs: z.array(z.string()).default([
      'node_modules',
      '.git',
      '.hg',
      '.svn',
      'dist',
      'build',
      '.venv',
      '.cache',
      'target',
    ]),
    readDenyDirs: z.array(z.string()).default([]).volatile(),
    readDenyFiles: z.array(z.string()).default([]).volatile(),
    /** When the mode-000 mask could not be created: hide the directory behind a tmpfs, or leave it unmasked. */
    maskFallback: z.union(['tmpfs', 'skip']).default('tmpfs'),
    /** Append "permission denied" to the runner's denial signatures, so a read refusal shows up as a policy denial. */
    readDenialSignature: z.boolean().default(true),
  })

  /** Effective lists are exposed through getters only — a declared field would shadow the getter. */

  /** @type {Map<string, {at: number, paths: string[]}>} cache of the per-root scan */
  protectedCache = new Map()

  mask = { available: false, dir: void 0, file: void 0 }

  config

  /** Effective lists; re-read on access (see syncLists). */
  lists = { roots: [], denySegments: [], readDirs: [], readFiles: [] }

  listsKey = null

  loggedSummary = null

  constructor(ctx, config) {
    super(ctx, 'betterSandbox')
    this.config = config
    this.selfPaths = selfPaths()
    this.prepareMask()

    // The harness reports updates of volatile fields with the loader/volatile-update event.
    // Memoization by resolved values stays the primary mechanism (it does not depend on
    // delivery order), while the subscription removes redundant recomputation per access.
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      this.listsKey = null
    }), 'better-sandbox: memo reset on volatile-update')
    this.syncLists()

    if (config.announceInPrompt) {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'sandbox:rules',
          order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
          text: () => {
            const lines = []
            if (this.roots.length > 0) {
              lines.push(
                `Additional write roots beyond the session workspace (workspace-write mode only): ${this.roots
                  .map((root) => JSON.stringify(root))
                  .join(', ')}.`,
              )
            }
            if (this.denySegments.length > 0) {
              lines.push(
                `Protected path names inside every writable root (workspace-write mode): ${this.denySegments
                  .map((segment) => JSON.stringify(segment))
                  .join(', ')} — writing there is refused the same way as writing outside the workspace, so escalate once with sandbox_permissions and a justification when the user genuinely needs it.`,
              )
            }
            const reads = [...this.readDirs, ...this.readFiles]
            if (reads.length > 0) {
              lines.push(
                `Protected from reading (secrets and personal data): ${reads
                  .map((path) => JSON.stringify(path))
                  .join(', ')} — reading their contents is refused for tools and denied inside sandboxed commands; escalate once with sandbox_permissions and a justification only when the user explicitly needs that file.`,
              )
            }
            return lines.join('\n')
          },
        })
      })
    }

    // ctx.effect expects a setup that returns a disposer: cleanup runs only on unload.
    ctx.effect(() => () => {
      if (this.mask.dir !== void 0) try {
        chmodSync(this.mask.dir, 0o755)
      } catch {}
      try {
        rmSync(join(pluginDir, '.mask'), { recursive: true, force: true })
      } catch {}
    }, 'better-sandbox mask')
  }

  /**
   * volatile fields (the rule lists) are resolved only after the entry has been
   * constructed, so the lists are re-read on access and rebuilt only when config or
   * the state file has changed.
   */
  syncLists() {
    const config = this.config
    const key = JSON.stringify([
      this.resolved(config.writableDirs),
      this.resolved(config.denySegments),
      this.resolved(config.readDenyDirs),
      this.resolved(config.readDenyFiles),
    ])
    const rejected = []
    const lists = {
      roots: this.collectDirs(this.liveList(config.writableDirs), this.selfPaths, 'writableDirs', rejected),
      denySegments: this.liveList(config.denySegments).filter((segment) => {
        if (typeof segment === 'string' && segment !== '' && !segment.includes('/') && segment !== '.' && segment !== '..' && !segment.startsWith('~')) return true
        this.ctx.logger.warn(`better-sandbox: denySegments: a single path name is required, skipped ${JSON.stringify(segment)}`)
        rejected.push({ field: 'denySegments', entry: segment, reason: 'segment' })
        return false
      }),
      readDirs: this.collectDirs(this.liveList(config.readDenyDirs), this.selfPaths, 'readDenyDirs', rejected),
      readFiles: this.collectFiles(this.liveList(config.readDenyFiles), 'readDenyFiles', rejected),
      rejected,
    }
    this.lists = lists
    this.protectedCache.clear()

    const summary = JSON.stringify([lists.roots, lists.denySegments, lists.readDirs, lists.readFiles])
    if (summary !== this.loggedSummary) {
      this.loggedSummary = summary
      this.ctx.logger.info(`better-sandbox: rules: write roots ${JSON.stringify(lists.roots)}, protected names ${JSON.stringify(lists.denySegments)}, closed for reading ${JSON.stringify([...lists.readDirs, ...lists.readFiles])}, mask ${this.mask.available ? 'mode 000' : `fallback ${config.maskFallback}`}`)
    }
  }

  /** Before resolution the value of a volatile field arrives as an empty node, not a list. */
  /**
   * volatile fields arrive as { get() } references (cosmokit) and their value changes at
   * runtime without remounting the entry — so the value is taken on access.
   */
  resolved(value) {
    return isVolatile(value) ? value.get() : value
  }

  liveList(value) {
    const resolved = this.resolved(value)
    return Array.isArray(resolved) ? resolved : []
  }


  get roots() {
    this.syncLists()
    return this.lists.roots
  }

  get denySegments() {
    this.syncLists()
    return this.lists.denySegments
  }

  get readDirs() {
    this.syncLists()
    return this.lists.readDirs
  }

  /** Config rules that cannot be applied, or apply only in part. */
  get rejected() {
    this.syncLists()
    return this.lists.rejected
  }

  get readFiles() {
    this.syncLists()
    return this.lists.readFiles
  }

  collectDirs(entries, self, field, sink) {
    const out = []
    for (const raw of entries) {
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const entry = expandHome(raw.trim())
      if (!isAbsolute(entry)) {
        this.ctx.logger.warn(`better-sandbox: ${field}: an absolute path or ~/… is required, skipped ${JSON.stringify(raw)}`)
        sink?.push({ field, entry: raw, reason: 'relative' })
        continue
      }
      const path = canonical(resolve(entry))
      // Guarding a root the harness reads its own code and state from does not break the
      // agent, it breaks the harness itself.
      if (self.some((own) => path === own || (own.length > path.length && own.startsWith(`${path}/`)))) {
        this.ctx.logger.warn(`better-sandbox: ${field} ${JSON.stringify(path)} covers a path of the harness itself — skipped`)
        sink?.push({ field, entry: raw, reason: 'covers-harness' })
        continue
      }
      if (!existsSync(path)) sink?.push({ field, entry: raw, reason: 'missing', path })
      out.push(path)
    }
    return out
  }

  collectFiles(entries, field, sink) {
    const out = []
    for (const raw of entries) {
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const entry = expandHome(raw.trim())
      if (!isAbsolute(entry)) {
        this.ctx.logger.warn(`better-sandbox: ${field}: an absolute path or ~/… is required, skipped ${JSON.stringify(raw)}`)
        sink?.push({ field, entry: raw, reason: 'relative' })
        continue
      }
      const path = canonical(resolve(entry))
      if (!existsSync(path)) sink?.push({ field, entry: raw, reason: 'missing', path })
      out.push(path)
    }
    return out
  }


  /** The mode-000 directory and empty file the mask uses to cover protected paths. */
  /**
   * The mask stubs live in the plugin folder and can disappear at runtime (for example
   * when the package is reinstalled). They are checked and restored on demand: otherwise
   * bwrap fails outright with "Can't find source path", and isolation drops for every
   * command at once.
   */
  maskUsable() {
    if (this.mask.dir !== void 0 && this.mask.file !== void 0 && existsSync(this.mask.dir) && existsSync(this.mask.file)) return true
    this.prepareMask()
    return this.mask.available === true && existsSync(this.mask.dir) && existsSync(this.mask.file)
  }

  prepareMask() {
    const root = join(pluginDir, '.mask')
    const dir = join(root, 'empty-dir')
    const file = join(root, 'empty-file')
    try {
      // Leftover from a previous run: the mask directory has mode 000, so it can be
      // neither removed nor worked around — give the permissions back first.
      for (const stale of [dir, root]) try {
        chmodSync(stale, 0o755)
      } catch {}
      try {
        chmodSync(join(root, 'empty-file'), 0o755)
      } catch {}
      rmSync(root, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      writeFileSync(file, '', { mode: 0o644 })
      chmodSync(dir, 0o000)
      chmodSync(file, 0o000)
      this.mask = { available: true, dir, file }
    } catch (error) {
      this.ctx.logger.warn(`better-sandbox: the mode-000 mask was not created (${String(error)}), fallback: ${this.config.maskFallback}`)
      this.mask = { available: false, dir, file: existsSync(file) ? file : void 0 }
    }
  }




  /** Assigns the lists without validation (to load saved state). */


  /** Snapshot for the UI: the lists, the service handles and the mask state. */
  snapshot() {
    return {
      writableDirs: [...this.roots],
      denySegments: [...this.denySegments],
      readDenyDirs: [...this.readDirs],
      readDenyFiles: [...this.readFiles],
      mask: { available: this.mask.available, fallback: this.config.maskFallback },
      rejected: this.lists.rejected,
      editable: true,
      scan: { depth: this.config.denyDepth, ttlMs: this.config.denyScanTtlMs, skipDirs: [...(this.config.denySkipDirs ?? [])] },
      reserved: [...this.selfPaths],
    }
  }

  /** Checks a path before it is added: absolute, not overlapping the harness itself, existing. */
  validatePath(kind, path) {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'empty' }
    const entry = expandHome(path.trim())
    if (!isAbsolute(entry)) return { ok: false, reason: 'relative' }
    const canonicalPathValue = canonical(resolve(entry))
    if (kind === 'readDir') {
      for (const own of this.selfPaths) {
        if (canonicalPathValue === own || own.startsWith(`${canonicalPathValue}/`)) return { ok: false, reason: 'covers-harness', path: canonicalPathValue }
      }
      const root = this.ctx.sandboxPolicy.workspaceRoot
      if (typeof root === 'string' && root.startsWith(`${canonicalPathValue}/`)) return { ok: false, reason: 'covers-workspace', path: canonicalPathValue }
    }
    return { ok: true, path: canonicalPathValue, exists: existsSync(canonicalPathValue) }
  }

  /** The protected segment name the canonical path lies in, if there is one. */
  deniedSegment(targetPath) {
    if (this.denySegments.length === 0) return void 0
    return segmentDenied(targetPath, this.denySegments)
  }

  /**
   * Whether a canonical path is protected from reading.
   * @param key the canonical path of the target.
   * @param allowDirRoot - `true` allows the protected directory itself (its existence is
   *   not a secret), but everything inside it stays closed; pass `false` when the
   *   contents are being listed.
   */
  readDeniedFor(key, allowDirRoot = true) {
    if (typeof key !== 'string') return void 0
    if (this.readFiles.includes(key)) return this.readFiles[this.readFiles.indexOf(key)]
    for (const dir of this.readDirs) {
      if (key === dir) {
        if (allowDirRoot) continue
        return dir
      }
      if (key.startsWith(`${dir}/`)) return dir
    }
    return void 0
  }

  /** Write-protected paths that exist under the listed roots (cached scan). */
  protectedUnder(roots) {
    const found = new Set()
    for (const root of roots) {
      for (const path of findProtectedUnder(
        root,
        this.denySegments,
        this.config.denyDepth ?? 3,
        this.config.denySkipDirs ?? [],
        this.config.denyScanTtlMs ?? 10_000,
        this.protectedCache,
      )) {
        found.add(path)
      }
    }
    return [...found]
  }
}
