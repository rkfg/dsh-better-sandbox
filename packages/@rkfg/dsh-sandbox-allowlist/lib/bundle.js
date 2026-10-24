/**
 * dsh-sandbox-allowlist/bundle: the bundle's entry group.
 *
 * The group keeps all four plugin rows in one subtree: it can be switched off as a
 * whole, and only such entries land on the configurable list (the settings page in
 * the web UI is built from entries in include subtrees).
 *
 * @module dsh-sandbox-allowlist/bundle
 */
const groupKey = Symbol.for('cordis.group')
const init = Symbol.for('cordis.init')

export default class SandboxAllowlistBundle {
  static inject = ['loader']
  static [groupKey] = true

  /** @param {any} ctx @param {any[]} config child rows from the bundle's patch layer */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  async *[init]() {
    const Group = this.ctx.loader?.builtins?.group
    if (typeof Group !== 'function') throw new Error('dsh-sandbox-allowlist/bundle needs the built-in cordis:group entry')
    const group = new Group(this.ctx, this.config)
    yield () => group.stop()
    await group.update(this.config)
  }
}
