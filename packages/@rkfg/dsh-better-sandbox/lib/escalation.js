/**
 * better-sandbox / escalation level.
 *
 * The harness advertises a closed ladder of escalation targets — `workspace-write` and
 * `danger-full-access` — pins that list in the `sandbox_permissions` enum of every
 * enforcing tool, and refuses any target absent from `WIDER_MODES`. So a call that needs
 * one protected path name opened has to ask for the whole filesystem, and the user is
 * asked to approve the whole filesystem. This entry adds one named level to the ladder:
 * `write-segment` (the token is configurable, an empty value turns the level off). The
 * level means: this single call runs under `workspace-write` with the names from
 * `denySegments` writable; the workspace boundary, the extra roots, and every read mask
 * stay exactly as in an ordinary call. `fs.js`, `runner.js` and `masks.js` honour the
 * token; this module only makes the vocabulary accept it.
 *
 * Two edits are needed, and neither is a service the plugin owns:
 *   `WIDER_MODES` gains the level under every mode it is wider than, so the shared
 *   `approveEscalation` treats it as strictly wider, asks the user, and hands the token
 *   back to the tool as the mode of that one call;
 *   the `sandbox_permissions` enum of the enforcing tools gains the token, so the model
 *   sees the level and its arguments pass schema validation.
 * Both facts are frozen at tool-apply time by the harness, so they are edited on the live
 * objects instead: the registry stores the definition it was given (no snapshot, no
 * freeze), `wireSchemas` projects that same `parameters` object into every prompt, and
 * the argument validation of `defineTool` closes over it too. A tool that mounts after
 * this entry is caught by the `tools/change` event; a rename or a turn-off is caught by
 * `loader/volatile-update`. Everything is undone when the entry stops.
 *
 * @module dsh-better-sandbox/escalation
 */
import { Service } from '@deepseek-ai/cordis'
import { ESCALATION_TARGETS, WIDER_MODES } from '@deepseek-ai/dsh-sandbox'

/** The tools that carry escalation fields AND honour a level: bash families and the two mutations. */
const SUBJECTS = {
  bash: 'command',
  pwsh: 'command',
  write: 'operation',
  edit: 'operation',
}

/**
 * The modes the level is strictly wider than: it grants what they grant plus the
 * protected names. `danger-full-access` has no row at all — nothing is wider than it,
 * and a session already running under it is not being refused anything.
 */
const REACHABLE_FROM = ['read-only', 'workspace-write']

export default class BetterSandboxEscalation extends Service {
  static inject = ['betterSandbox', 'tools']

  /** tool name → the schema field and its original description, so a revert is exact. */
  patched = new Map()

  /** [token, targets] pairs whose array this entry appended to. */
  widened = []

  /** Last reported "level + tools" summary, so a repeated `tools/change` stays quiet. */
  reported = null

  constructor(ctx, config) {
    super(ctx, 'sandboxEscalation')
    ctx.effect(() => {
      const offChange = ctx.on('tools/change', () => this.apply())
      const offVolatile = ctx.on('loader/volatile-update', () => this.apply())
      this.apply()
      return () => this.revert(offChange, offVolatile)
    }, 'better-sandbox: escalation level')
  }

  get allow() {
    return this.ctx.betterSandbox
  }

  /** The configured token, or `''` when the level is off. */
  get level() {
    return this.allow.segmentLevel
  }

  /**
   * Add the level to one tool's `sandbox_permissions` field. Idempotent: the enum gets
   * the token once, and the description is recomposed from the original every time, so a
   * rename or a `tools/change` burst cannot stack hints.
   *
   * @param field - the `sandbox_permissions` spec of a registered tool.
   * @param subject - the family's noun (`command` for a shell, `operation` for a mutation).
   * @param key - the tool name the field belongs to, kept for the revert.
   * @returns whether the field was reachable (an enum the harness did not publish is skipped).
   */
  patchField(field, subject, key = subject) {
    const level = this.level
    if (!isField(field) || level === '') return false
    const known = this.patched.get(key) ?? { field, description: field.description, token: level }
    this.patched.set(key, known)
    if (known.token !== level) {
      // The level was renamed while the tool stayed mounted: the old token has to leave
      // the enum, or the model would be offered a level nothing can grant.
      field.enum = field.enum.filter((target) => target !== known.token)
      known.token = level
    }
    if (!field.enum.includes(level)) field.enum.push(level)
    // Recomposed from the original every time, so a `tools/change` burst cannot stack hints.
    field.description = `${known.description} ${this.hint(level, subject)}`
    return true
  }

  /** What the level opens, phrased for the model that has to choose between targets. */
  hint(level, subject) {
    const names = this.allow.denySegments
    const opened = names.length === 0 ? 'the protected path names' : `the protected path names (${names.join(', ')})`
    return `This deployment adds the level "${level}": the exact ${subject} runs under the session's usual mode with ${opened} writable, for this call only and with the user's approval. Choose it over a wider mode whenever the refusal is about one of those names.`
  }

  /** Apply the level to the vocabulary: the strict-wider table and every mounted tool. */
  apply() {
    const level = this.level
    if (level === '') {
      this.unpatchTools()
      this.unwiden()
      return
    }
    // A rename leaves the previous token's rows behind unless they are dropped here.
    this.widened = this.widened.filter(([token, targets]) => {
      if (token === level) return true
      const at = targets.indexOf(token)
      if (at !== -1) targets.splice(at, 1)
      return false
    })
    for (const mode of REACHABLE_FROM) {
      const targets = WIDER_MODES[mode]
      if (!Array.isArray(targets) || targets.includes(level)) continue
      targets.push(level)
      this.widened.push([level, targets])
    }
    for (const [name, subject] of Object.entries(SUBJECTS)) {
      const field = this.ctx.tools.get(name)?.parameters?.properties?.sandbox_permissions
      this.patchField(field, subject, name)
    }
    // `tools/change` fires for every registration and every scope restriction, so the
    // report is written only when the answer actually changed.
    const summary = `${level} ${[...this.patched.keys()].sort().join(',')}`
    if (summary !== this.reported) {
      this.reported = summary
      const listed = [...this.patched.keys()].join(', ')
      this.ctx.logger.info(`better-sandbox: escalation level ${JSON.stringify(level)} offered by ${listed === '' ? 'no mounted tool yet' : listed}`)
    }
  }

  /** Take the token back out of every tool schema this entry touched. */
  unpatchTools() {
    for (const { field, description, token } of this.patched.values()) {
      field.enum = field.enum.filter((target) => target !== token)
      field.description = description
    }
    this.patched.clear()
  }

  /** Remove the rows this entry appended to the strict-wider table. */
  unwiden() {
    for (const [token, targets] of this.widened) {
      const at = targets.indexOf(token)
      if (at !== -1) targets.splice(at, 1)
    }
    this.widened = []
  }

  /** Full undo: tool schemas, then the strict-wider table, then the subscriptions. */
  revert(offChange, offVolatile) {
    this.unpatchTools()
    this.unwiden()
    offChange?.()
    offVolatile?.()
  }

  /** Snapshot for the Remote API and the verification driver. */
  state() {
    return {
      level: this.level,
      reachableFrom: REACHABLE_FROM,
      tools: Object.keys(SUBJECTS),
      patched: [...this.patched.keys()],
    }
  }
}

/** A `sandbox_permissions` field the harness published: a string enum with a description. */
const isField = (field) =>
  field !== null && typeof field === 'object' && Array.isArray(field.enum) && typeof field.description === 'string'
