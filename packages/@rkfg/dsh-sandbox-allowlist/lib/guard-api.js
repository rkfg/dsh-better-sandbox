/**
 * sandbox-allowlist / Remote service `sandboxGuard`: a snapshot of the rules and a
 * path check for tools and tests. It does not edit the lists: the editable fields of
 * the sandbox-allowlist row are marked volatile, so editing goes through the harness
 * settings layer (the "Sandbox" page) and is applied without remounting the entries.
 *
 * The `Remote` decorator is applied by hand (the same protocol the harness's compiled
 * plugins use): the marker is placed on the service prototype, so `remoteMethods()`
 * sees the methods as usual. Private methods are impossible in this service — calls
 * go through the cordis proxy.
 *
 * @module dsh-sandbox-allowlist/guard-api
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'


/** The rule kinds `validate` understands. */
const KINDS = new Set(['writableDir', 'denySegment', 'readDir', 'readFile'])

export default class SandboxGuardApi extends TypertRemoteService {
  static inject = ['sandboxAllowlist']

  constructor(ctx) {
    super(ctx, 'sandboxGuard')
    ctx.logger.info('sandbox-allowlist: remote API sandboxGuard published')
  }

  get allow() {
    return this.ctx.sandboxAllowlist
  }

  state() {
    return this.allow.snapshot()
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
    if (!KINDS.has(kind)) throw new RemoteError('sandbox-allowlist/invalid-kind', `sandbox-allowlist: unknown rule kind ${JSON.stringify(kind)}`, { kind, kinds: [...KINDS] })
    return this.allow.validatePath(kind, path)
  }

}

// Remote markers: the same route the compiled plugins take (the decorator
// calls addInitializer with this === the instance, so the marker lands on the prototype).
const markRemoteMethods = (prototype, names) => {
  const probe = Object.create(prototype)
  for (const name of names) {
    const method = prototype[name]
    if (typeof method !== 'function') throw new Error(`sandbox-allowlist: no method ${name} for Remote`)
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
