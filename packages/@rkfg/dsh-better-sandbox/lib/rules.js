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
import { existsSync, lstatSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, findProtectedUnder, isUnder, segmentDenied, stubProblem, TRUNCATED_REPORT_LIMIT } from './policy.js'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'

const pluginDir = dirname(fileURLToPath(import.meta.url))

/**
 * Mode names a level may not take: the harness' own ladder. `read-only` is spelled out
 * because the advertised escalation targets only list what a call may escalate TO.
 */
const RESERVED_MODES = new Set(['read-only', ...ESCALATION_TARGETS])

/** A level token reaches the model-facing schema, so it is kept to a plain lowercase word. */
const LEVEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

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

/**
 * Make a mask stub removable. A stub that was turned into a symlink is removed rather
 * than chmodded: `chmod` follows the link and would change the mode of its target.
 *
 * @param path - the stub path to release.
 */
const releaseStub = (path) => {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) rmSync(path, { force: true })
    else chmodSync(path, 0o755)
  } catch {}
}

/**
 * A protected entry is a single path name, matched against every level of every writable
 * root: separators, traversal and whitespace padding would turn it into something the name
 * comparison can never reach.
 */
const isSegmentName = (value) =>
  typeof value === 'string' && value !== '' && value === value.trim() && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..' && !value.startsWith('~')

/**
 * The files of the harness itself: its own package and this plugin's folder. Two things
 * follow from them. A rule may not cover them (the harness would stop being able to read
 * its own code and state), and a rule may not lie inside them either — the mask stubs live
 * in the plugin folder, and a writable stub is no stub at all.
 */
const harnessPaths = () => {
  const out = [pluginDir]
  try {
    const packageDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis/package.json')))
    out.push(dirname(dirname(dirname(packageDir))))
  } catch {}
  return out.map(canonical).filter((path) => isAbsolute(path))
}

/**
 * Where this process works. A read rule may not cover it: the mask would have to be
 * skipped for the session to keep a working directory. Rules inside it are ordinary — that
 * is where the secrets of a project live.
 */
const workingPaths = () => [canonical(process.cwd())].filter((path) => isAbsolute(path))

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
    /**
     * How long a protected-name scan stays valid. 0 re-walks every root for every command:
     * a directory created moments ago is then protected by the very next command, at the
     * cost of a synchronous walk each time.
     */
    denyScanTtlMs: z.natural().default(10_000),
    /**
     * Extra places to look for the protected names, beyond the working root and the write
     * grants. The walk is bounded by `denyDepth`, so a repository nested deeper than that
     * under the working root stays unprotected inside commands; pointing the scan at it
     * costs one bounded walk instead of raising the depth for every root.
     */
    denyScanRoots: z.array(z.string()).default([]).volatile(),
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
    /**
     * The name of the escalation level that opens `denySegments` for one approved call
     * (see `escalation.js`). An empty value turns the level off; the name must not
     * collide with a mode of the harness ladder.
     */
    segmentLevel: z.string().default('write-segment').volatile(),
    /** When the mode-000 mask could not be created: hide the directory behind a tmpfs, or leave it unmasked. */
    maskFallback: z.union(['tmpfs', 'skip']).default('tmpfs'),
    /**
     * How a masked read is recognized in the output of a command: `paths` reports a refusal
     * only when the output names a protected path, `any` also accepts the bare wording
     * "permission denied", `off` reports nothing. The wording is what the kernel produces, so
     * `any` cannot tell a masked read from any other permission error.
     */
    readDenialSignature: z.union(['paths', 'any', 'off']).default('paths'),
  })

  /** Effective lists are exposed through getters only — a declared field would shadow the getter. */

  /** @type {Map<string, {at: number, paths: string[], truncated: string[]}>} cache of the per-root scan */
  protectedCache = new Map()

  /**
   * Why a rule is not in force, keyed by cause: `hole` marks the cases where a protection
   * the user configured is absent, as opposed to a rule that simply did not install.
   *
   * A rule that silently stopped being enforced is worse than no rule: the user believes the
   * boundary holds and the agent meets nothing. Every reason is kept so the settings page can
   * show it, and a hole is also announced in the model context. Reasons are cleared as soon
   * as a confinement proves the protection applies again.
   *
   * @type {Map<string, {key: string, message: string, hole: boolean}>}
   */
  guardGaps = new Map()

  /** A configured protection is not being applied: the model has to know before relying on it. */
  noteHole(key, message) {
    this.guardGaps.set(key, { key, message, hole: true })
  }

  /** A rule could not be installed as configured: worth showing the user, not announcing to the model. */
  noteIssue(key, message) {
    this.guardGaps.set(key, { key, message, hole: false })
  }

  clearGap(key) {
    this.guardGaps.delete(key)
  }

  /** The active reasons, phrased for the model: holes only. */
  get gaps() {
    return [...this.guardGaps.values()].filter((row) => row.hole).map((row) => row.message.replace(/^better-sandbox: /, ''))
  }

  /** Every active reason, for the settings page. */
  get notices() {
    return [...this.guardGaps.values()].map((row) => ({ key: row.key, message: row.message.replace(/^better-sandbox: /, ''), hole: row.hole }))
  }

  mask = { available: false, dir: void 0, file: void 0 }

  /**
   * Whether this instance still admits confinements. Teardown closes the gate and a
   * closed gate never reopens: the mask stubs of a disposed owner stay removed.
   */
  admitting = true

  /** Confinements admitted before the gate closed; the mask is released only after they are built. */
  leases = new Set()

  /** Set once the mask disposer has run: the stubs are never written again by this instance. */
  disposed = false

  config

  /** Effective lists; re-read on access (see syncLists). */
  lists = { roots: [], denySegments: [], readDirs: [], readFiles: [], scanRoots: [] }

  /** Where the bounded walk stopped on the last scan (a sample and an exact count). */
  scanTruncated = { count: 0, paths: [] }

  listsKey = null

  loggedSummary = null

  constructor(ctx, config) {
    super(ctx, 'betterSandbox')
    this.config = config
    this.harnessPaths = harnessPaths()
    this.workingPaths = workingPaths()
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
                  .join(', ')} — writing there is refused the same way as writing outside the workspace.`,
              )
              const level = this.segmentLevel
              if (level !== '') {
                lines.push(
                  `Escalation level ${JSON.stringify(level)}: when a write or a command is refused only because of one of those names, retry that exact call once with sandbox_permissions set to ${JSON.stringify(level)} and a one-sentence justification. It opens every name above for that single call, with the user's approval; every other rule stays exactly as it is. Prefer it over a wider mode.`,
                )
              }
            }
            const reads = [...this.readDirs, ...this.readFiles]
            if (reads.length > 0) {
              lines.push(
                `Protected from reading (secrets and personal data): ${reads
                  .map((path) => JSON.stringify(path))
                  .join(', ')} — reading their contents is refused for tools and denied inside sandboxed commands. Nothing opens them for one call: an escalation cannot cover a read, so ask the user to change the rule when the file is genuinely needed.`,
              )
            }
            // A rule that silently stopped being enforced is the failure mode a security
            // feature must never have: the user believes the boundary holds and the agent
            // meets nothing. The reasons come from the confinement seams.
            const gaps = this.gaps
            if (gaps.length > 0) {
              lines.push(
                `Sandbox guards are NOT applied here: ${gaps.join('; ')}. The rules above still bind the file tools, but commands run without that part of the protection.`,
              )
            }
            return lines.join('\n')
          },
        })
      })
    }

    // ctx.effect expects a setup that returns a disposer: cleanup runs only on unload.
    // The stubs are the resource the confinement seams of the sibling entries read while
    // they finish the commands they already accepted, so the gate closes first, the
    // accepted commands are awaited, and only then do the files go.
    ctx.effect(() => async () => {
      await this.closeAdmission()
      this.disposed = true
      const root = join(pluginDir, '.mask')
      for (const stub of [this.mask.dir, this.mask.file, join(root, 'empty-dir'), root]) releaseStub(stub)
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {}
    }, 'better-sandbox mask')
  }

  /**
   * Take the owner for the length of one confinement.
   *
   * A confinement reads the mask stubs after an `await`, by which time the row holding
   * this service may already be unloading. The lease keeps the stubs in place for the
   * commands that were accepted while the owner was alive; once the gate is closed the
   * caller gets `held: false` and must not expect a mask to be created for it.
   *
   * @returns `held` — whether the owner is still mounted; `release` — the exact end of
   *   the lease, which has to run even when the confinement fails.
   */
  lease() {
    if (!this.admitting) return { held: false, release: () => {} }
    let settle
    const settled = new Promise((resolve) => { settle = resolve })
    this.leases.add(settled)
    return {
      held: true,
      release: () => {
        if (!this.leases.delete(settled)) return
        settle()
      },
    }
  }

  /** Close the gate, then wait until every accepted confinement has finished building. */
  async closeAdmission() {
    this.admitting = false
    while (this.leases.size > 0) {
      await Promise.allSettled([...this.leases])
    }
  }

  /**
   * volatile fields (the rule lists) are resolved only after the entry has been
   * constructed, so the lists are re-read on access and rebuilt only when a resolved list
   * has changed. The comparison decides: without it every access rebuilt the lists and
   * dropped the protected-name scan cache, so each command paid the full walk of every
   * root again — several times per command, once per getter.
   */
  syncLists() {
    const config = this.config
    const key = JSON.stringify([
      this.resolved(config.writableDirs),
      this.resolved(config.denySegments),
      this.resolved(config.readDenyDirs),
      this.resolved(config.readDenyFiles),
      this.resolved(config.denyScanRoots),
    ])
    if (key === this.listsKey) return
    this.listsKey = key
    const rejected = []
    const lists = {
      roots: this.collectDirs(this.liveList(config.writableDirs), 'writableDirs', rejected, 'write'),
      denySegments: this.liveList(config.denySegments).filter((segment) => {
        if (isSegmentName(segment)) return true
        this.ctx.logger.warn(`better-sandbox: denySegments: a single path name is required, skipped ${JSON.stringify(segment)}`)
        rejected.push({ field: 'denySegments', entry: segment, reason: 'segment' })
        return false
      }),
      readDirs: this.collectDirs(this.liveList(config.readDenyDirs), 'readDenyDirs', rejected, 'read'),
      readFiles: this.collectFiles(this.liveList(config.readDenyFiles), 'readDenyFiles', rejected, 'read'),
      scanRoots: this.collectDirs(this.liveList(config.denyScanRoots), 'denyScanRoots', rejected, 'write'),
      rejected,
    }
    this.lists = lists
    this.protectedCache.clear()

    const summary = JSON.stringify([lists.roots, lists.denySegments, lists.readDirs, lists.readFiles, rejected, this.installRisk])
    if (summary !== this.loggedSummary) {
      this.loggedSummary = summary
      this.ctx.logger.info(`better-sandbox: rules: write roots ${JSON.stringify(lists.roots)}, protected names ${JSON.stringify(lists.denySegments)}, closed for reading ${JSON.stringify([...lists.readDirs, ...lists.readFiles])}, mask ${this.mask.available ? 'mode 000' : `fallback ${config.maskFallback}`}`)
      // The Settings page has no channel to this service, so everything the host decided
      // about the configured rules has to reach the operator through the log.
      if (rejected.length > 0) this.ctx.logger.warn(`better-sandbox: ${rejected.length} rule(s) refused: ${rejected.map((row) => `${row.field} ${JSON.stringify(row.entry)} (${row.reason})`).join(', ')}`)
      if (this.installRisk !== '') this.ctx.logger.warn(`better-sandbox: the plugin folder ${JSON.stringify(this.installRisk)} lies inside a working root, so the mask stubs are writable from there — install the package under a DSH_HOME outside the workspace`)
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

  /** Extra roots to walk for the protected names (see `denyScanRoots`). */
  get scanRoots() {
    this.syncLists()
    return this.lists.scanRoots
  }

  get readFiles() {
    this.syncLists()
    return this.lists.readFiles
  }

  /**
   * The escalation level token in force, or `''` when it is switched off. A token that
   * collides with the harness ladder or cannot be shown to the model is reported once and
   * disables the level: silently keeping a broken name would advertise a mode nobody can
   * grant.
   */
  get segmentLevel() {
    const raw = String(this.resolved(this.config.segmentLevel) ?? '').trim()
    if (raw === '') return ''
    if (RESERVED_MODES.has(raw)) {
      this.warnOnceLevel(`reserved-${raw}`, `better-sandbox: segmentLevel ${JSON.stringify(raw)} is a mode of the harness ladder, the level is off`)
      return ''
    }
    if (!LEVEL_PATTERN.test(raw)) {
      this.warnOnceLevel(`pattern-${raw}`, `better-sandbox: segmentLevel ${JSON.stringify(raw)} must be a lowercase word such as "write-segment", the level is off`)
      return ''
    }
    return raw
  }

  /** Whether a policy mode is this plugin's level rather than a mode of the harness ladder. */
  isSegmentLevel(mode) {
    const level = this.segmentLevel
    return level !== '' && mode === level
  }

  warnOnceLevel(key, message) {
    if (this.warnedLevels?.has(key) === true) return
    this.warnedLevels ??= new Set()
    this.warnedLevels.add(key)
    this.ctx.logger.warn(message)
  }

  /**
   * Why a rule cannot be applied, or `''` when it can. The boundaries are checked here
   * rather than in the settings form because the form writes the lists directly, so this
   * is the only place every rule passes through:
   *   `root` — one rule would cover every path the session works in;
   *   `covers-harness` — guarding a path the harness reads its own code and state from
   *   does not restrict the agent, it breaks the harness;
   *   `inside-harness` — a rule placed inside a path of the harness makes that path
   *   writable, and a writable mask stub is no mask at all: the bind follows its source;
   *   `covers-workspace` (read rules only) — a mask over the working directory has to be
   *   skipped for the session to keep a working directory, so such a rule protects
   *   nothing while looking as if it did. A rule *inside* the working directory is the
   *   normal case: that is where the secrets of a project live.
   *
   * @param path - the canonical rule path.
   * @param kind - `read` or `write`, the family the rule belongs to.
   */
  ruleProblem(path, kind) {
    if (path === sep) return 'root'
    if (this.harnessPaths.some((own) => isUnder(own, path))) return 'covers-harness'
    if (this.harnessPaths.some((own) => isUnder(path, own))) return 'inside-harness'
    if (kind === 'read') {
      const root = this.ctx.sandboxPolicy.workspaceRoot
      if (this.workingPaths.some((own) => isUnder(own, path)) || (typeof root === 'string' && isUnder(root, path))) return 'covers-workspace'
    }
    return ''
  }

  /**
   * @param kind - the family the rules belong to, passed to {@link ruleProblem}.
   */
  collectDirs(entries, field, sink, kind) {
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
      const problem = this.ruleProblem(path, kind)
      if (problem !== '') {
        this.ctx.logger.warn(`better-sandbox: ${field} ${JSON.stringify(path)} is refused (${problem})`)
        sink?.push({ field, entry: raw, reason: problem, path })
        continue
      }
      if (!existsSync(path)) sink?.push({ field, entry: raw, reason: 'missing', path })
      out.push(path)
    }
    return out
  }

  collectFiles(entries, field, sink, kind) {
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
      const problem = this.ruleProblem(path, kind)
      if (problem !== '') {
        this.ctx.logger.warn(`better-sandbox: ${field} ${JSON.stringify(path)} is refused (${problem})`)
        sink?.push({ field, entry: raw, reason: problem, path })
        continue
      }
      if (!existsSync(path)) sink?.push({ field, entry: raw, reason: 'missing', path })
      out.push(path)
    }
    return out
  }


  /** The mode-000 directory and empty file the mask uses to cover protected paths. */
  /**
   * The stubs live in the plugin folder and can disappear at runtime (for example when
   * the package is reinstalled). They are checked and rebuilt on demand: otherwise bwrap
   * fails outright with "Can't find source path", and isolation drops for every command
   * at once. The check covers the type and the mode and not just the existence — mode 000
   * alone is no defence, because the owner of a stub can always give themselves write
   * access back and replace it, so an altered stub has to be noticed.
   */
  /** One report per reason: the stubs are checked before every command. */
  warnOnceMask(reason, message) {
    if (this.warnedMasks?.has(reason) === true) return
    this.warnedMasks ??= new Set()
    if (this.warnedMasks.size >= 16) this.warnedMasks.clear()
    this.warnedMasks.add(reason)
    this.ctx.logger.warn(message)
  }

  maskUsable() {
    // A disposed owner has already run its mask disposer: report the mask as
    // unavailable and let the caller take its documented fallback rather than
    // leaving a fresh pair of mode-000 files behind nobody will remove.
    if (this.disposed) return false
    const dirProblem = stubProblem(this.mask.dir, 'dir')
    const fileProblem = stubProblem(this.mask.file, 'file')
    if (dirProblem === '' && fileProblem === '') return true
    this.warnOnceMask(
      `stub-${dirProblem}-${fileProblem}`,
      `better-sandbox: the mask stubs are not intact (directory: ${dirProblem || 'ok'}, file: ${fileProblem || 'ok'}), rebuilding them — a replaced stub would expose the paths it points at`,
    )
    this.prepareMask()
    return stubProblem(this.mask.dir, 'dir') === '' && stubProblem(this.mask.file, 'file') === ''
  }

  /** Rebuild the stubs, releasing them first whatever their current shape is. */
  prepareMask() {
    const root = join(pluginDir, '.mask')
    const dir = join(root, 'empty-dir')
    const file = join(root, 'empty-file')
    if (this.disposed) {
      this.mask = { available: false, dir, file: void 0 }
      return
    }
    try {
      // Leftover from a previous run: the mask directory has mode 000, so it can be
      // neither removed nor worked around — give the permissions back first.
      for (const stale of [dir, root, file]) releaseStub(stale)
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
      segmentLevel: this.segmentLevel,
      mask: { available: this.mask.available, fallback: this.config.maskFallback },
      rejected: this.lists.rejected,
      gaps: this.gaps,
      notices: this.notices,
      installRisk: this.installRisk,
      editable: true,
      scan: {
        depth: this.config.denyDepth,
        ttlMs: this.config.denyScanTtlMs,
        skipDirs: [...(this.config.denySkipDirs ?? [])],
        extraRoots: [...this.scanRoots],
        truncated: this.scanTruncated,
      },
      reserved: [...this.harnessPaths, ...this.workingPaths],
    }
  }

  /**
   * The plugin folder when the session's working root contains it. The mask stubs live
   * inside the plugin folder, and a stub the agent can write to is a stub the agent can
   * replace, so an installation inside a working root has to be visible to the user even
   * though every command re-verifies the stubs.
   */
  get installRisk() {
    const root = this.ctx.sandboxPolicy.workspaceRoot
    return typeof root === 'string' && isUnder(pluginDir, root) ? pluginDir : ''
  }

  /** Checks a rule before it is added, with the same answers {@link collectDirs} gives. */
  validatePath(kind, value) {
    if (kind === 'segmentLevel') {
      // The token is not a path: an empty value switches the level off, anything else has
      // to be a plain lowercase word that is not a mode of the harness ladder.
      const token = String(value ?? '').trim()
      if (token === '') return { ok: true, path: '', exists: false }
      if (RESERVED_MODES.has(token)) return { ok: false, reason: 'reserved-level', path: token }
      if (!LEVEL_PATTERN.test(token)) return { ok: false, reason: 'level-pattern', path: token }
      return { ok: true, path: token, exists: true }
    }
    if (kind === 'denySegment') {
      // A protected entry is a single path name, never a path: the name is matched against
      // every level of every writable root.
      const name = typeof value === 'string' ? value : ''
      if (!isSegmentName(name)) return { ok: false, reason: 'segment', path: name }
      return { ok: true, path: name, exists: true }
    }
    if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'empty' }
    const entry = expandHome(value.trim())
    if (!isAbsolute(entry)) return { ok: false, reason: 'relative' }
    const canonicalPathValue = canonical(resolve(entry))
    const problem = this.ruleProblem(canonicalPathValue, kind === 'readDir' || kind === 'readFile' ? 'read' : 'write')
    if (problem !== '') return { ok: false, reason: problem, path: canonicalPathValue }
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

  /** Write-protected paths that exist under the scanned roots (cached scan). */
  protectedUnder(roots) {
    const found = new Set()
    const truncated = []
    let truncatedCount = 0
    // Where the walk stopped is reported for the roots a user thinks of as their own tree.
    // A write grant is a cache or a toolchain: it always contains thousands of directories,
    // and a report from there is noise that hides the one that matters.
    const grants = new Set(this.roots)
    for (const root of [...roots, ...this.scanRoots]) {
      const scan = findProtectedUnder(
        root,
        this.denySegments,
        this.config.denyDepth ?? 3,
        this.config.denySkipDirs ?? [],
        this.config.denyScanTtlMs ?? 10_000,
        this.protectedCache,
      )
      for (const path of scan.paths) found.add(path)
      if (grants.has(root)) continue
      truncatedCount += scan.truncatedCount
      for (const path of scan.truncated) if (truncated.length < TRUNCATED_REPORT_LIMIT) truncated.push(path)
    }
    this.scanTruncated = { count: truncatedCount, paths: truncated }
    return [...found]
  }
}
