/**
 * sandbox-allowlist / Remote-сервис `sandboxGuard`: снимок правил и проверка
 * пути для инструментов и тестов. Правку списков не делает: editable-поля строки
 * sandbox-allowlist помечены volatile, поэтому редактирование идёт через слой
 * настроек харнесса (страница «Sandbox») и применяется без перемонтирования
 * записей.
 *
 * Декоратор `Remote` применён вручную (по тому же протоколу, что и компилированные
 * плагины харнесса): маркер кладётся в прототип сервиса, поэтому `remoteMethods()`
 * видит методы как обычно. Приватные методы в этом сервисе невозможны — вызов
 * идёт через прокси cordis.
 *
 * @module dsh-sandbox-allowlist/guard-api
 */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'


/** Виды правил, которые понимает `validate`. */
const KINDS = new Set(['writableDir', 'denySegment', 'readDir', 'readFile'])

export default class SandboxGuardApi extends TypertRemoteService {
  static inject = ['sandboxAllowlist']

  constructor(ctx) {
    super(ctx, 'sandboxGuard')
    ctx.logger.info('sandbox-allowlist: remote API sandboxGuard опубликован')
  }

  get allow() {
    return this.ctx.sandboxAllowlist
  }

  state() {
    return this.allow.snapshot()
  }

  /**
   * Проверяет путь перед тем, как добавить его в список.
   *
   * Отказ разговаривает языком Remote: один класс `RemoteError` и код
   * `<domain>/<reason>`, а не семейство доменных ошибок — так потребитель
   * различает случай по `error.code`, а не по тексту.
   *
   * @param kind - один из `writableDir`, `denySegment`, `readDir`, `readFile`.
   * @param path - путь из UI.
   * @returns результат проверки: `ok`, канонический путь и признак существования.
   */
  validate(kind, path) {
    if (!KINDS.has(kind)) throw new RemoteError('sandbox-allowlist/invalid-kind', `sandbox-allowlist: неизвестный вид правила ${JSON.stringify(kind)}`, { kind, kinds: [...KINDS] })
    return this.allow.validatePath(kind, path)
  }

}

// Remote-маркеры: тот же путь, что у компилированных плагинов (декоратор
// вызывает addInitializer с this === экземпляр, маркер ложится в прототип).
const markRemoteMethods = (prototype, names) => {
  const probe = Object.create(prototype)
  for (const name of names) {
    const method = prototype[name]
    if (typeof method !== 'function') throw new Error(`sandbox-allowlist: нет метода ${name} для Remote`)
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
