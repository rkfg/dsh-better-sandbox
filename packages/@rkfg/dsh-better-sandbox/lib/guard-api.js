/**
 * better-sandbox / Remote service `sandboxGuard`: a snapshot of the rules and a
 * path check for tools and tests. It does not edit the lists: the editable fields of
 * the better-sandbox row are marked volatile, so editing goes through the harness
 * settings layer (the "Sandbox" page) and is applied without remounting the entries.
 *
 * The `Remote` decorator is applied by hand (the same protocol the harness's compiled
 * plugins use): the marker is placed on the service prototype, so `remoteMethods()`
 * sees the methods as usual. Private methods are impossible in this service — calls
 * go through the cordis proxy.
 *
 * @module dsh-better-sandbox/guard-api
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'


/** The rule kinds `validate` understands. */
const KINDS = new Set(['writableDir', 'denySegment', 'readDir', 'readFile', 'segmentLevel'])

export default class SandboxGuardApi extends TypertRemoteService {
  static inject = ['betterSandbox']

  constructor(ctx) {
    super(ctx, 'sandboxGuard')
    ctx.logger.info('better-sandbox: remote API sandboxGuard published')
  }

  get allow() {
    return this.ctx.betterSandbox
  }

  state() {
    // Read lazily on purpose: declaring `sandboxEscalation` in `inject` would move this
    // entry later in the activation order, and a consumer that only injects `sandboxGuard`
    // would then read it as absent.
    return { ...this.allow.snapshot(), escalation: this.ctx.get('sandboxEscalation')?.state?.() ?? null }
  }

  /**
   * Validates a path before it is added to a list.
   *
   * The refusal speaks the Remote language: one `RemoteError` class and a
   * `<domain>/<reason>` code instead of a family of domain errors — so the consumer
   * tells the cases apart by `error.code`, not by the text.
   *
   * @param kind - one of `writableDir`, `denySegment`, `readDir`, `readFile`.
   * @param path - a path coming from the UI.
   * @returns the check result: `ok`, the canonical path and whether it exists.
   */
  validate(kind, path) {
    if (!KINDS.has(kind)) throw new RemoteError('better-sandbox/invalid-kind', `better-sandbox: unknown rule kind ${JSON.stringify(kind)}`, { kind, kinds: [...KINDS] })
    return this.allow.validatePath(kind, path)
  }

}

// Remote markers: the same route the compiled plugins take (the decorator
// calls addInitializer with this === the instance, so the marker lands on the prototype).
const markRemoteMethods = (prototype, names) => {
  const probe = Object.create(prototype)
  for (const name of names) {
    const method = prototype[name]
    if (typeof method !== 'function') throw new Error(`better-sandbox: no method ${name} for Remote`)
    Remote(name)(method, {
      kind: 'method',
      name,
      private: false,
      static: false,
      addInitializer(initializer) {
        initializer.call(probe)
      },
    })
  }
}

markRemoteMethods(SandboxGuardApi.prototype, ['state', 'validate'])
