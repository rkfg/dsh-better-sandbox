/**
 * dsh-sandbox-allowlist/bundle: группа записей бандла.
 *
 * Группа нужна, чтобы все четыре строки плагина жили одним поддеревом: его можно
 * выключить целиком, и именно такие записи попадают в список настраиваемых
 * (страница настроек в веб-UI строится по записям из include-поддеревьев).
 *
 * @module dsh-sandbox-allowlist/bundle
 */
const groupKey = Symbol.for('cordis.group')
const init = Symbol.for('cordis.init')

export default class SandboxAllowlistBundle {
  static inject = ['loader']
  static [groupKey] = true

  /** @param {any} ctx @param {any[]} config дочерние строки из patch-слоя бандла */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  async *[init]() {
    const Group = this.ctx.loader?.builtins?.group
    if (typeof Group !== 'function') throw new Error('dsh-sandbox-allowlist/bundle нужна встроенная запись cordis:group')
    const group = new Group(this.ctx, this.config)
    yield () => group.stop()
    await group.update(this.config)
  }
}
