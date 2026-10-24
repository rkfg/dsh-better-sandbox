// Зонд счётчика ревизий слоя настроек: почему update() принимает не любую правку,
// а только ту, что сделана от актуального снимка. Вызов идёт по таймеру, вне стека
// активации записи: config-editor берёт лок на package.json профиля, который
// стартовый проход держит, и вызов прямо из apply() упирается в таймаут блокировки.
//
//   DSH_PROBE=revision ./scripts/webfull.sh
export const name = 'revision-probe'
export const inject = ['settings']

export function apply(ctx) {
  setTimeout(function () {
    const out = []
    const row = function () {
      return Promise.resolve(ctx.settings.describe()).then(function (rows) {
        return rows.find(function (entry) { return entry.ns === 'sandbox-allowlist' })
      })
    }
    row()
      .then(function (first) {
        out.push(`ревизия документа: ${first.revision}, полей в value: ${Object.keys(first.value ?? {}).length}`)
        // Правка от устаревшего снимка: так выглядит второй браузер, который
        // держит значение до того, как профиль поправился в другом месте.
        return ctx.settings.update('sandbox-allowlist', { denySegments: ['.git'] }, first.revision + 1000)
          .then(function () {
            out.push('устаревшая ревизия: ПРИНЯТА (ожидался отказ — терялась бы чужая правка)')
          })
          .catch(function (error) {
            out.push(`устаревшая ревизия: отказ code=${error.code ?? 'нет'} :: ${String(error.message ?? error).slice(0, 120)}`)
          })
      })
      .then(function () {
        return row()
      })
      .then(function (fresh) {
        out.push(`ревизия после отказа: ${fresh.revision} (не изменилась)`)
        return ctx.settings.update('sandbox-allowlist', { denySegments: fresh.value.denySegments ?? ['.git'] }, fresh.revision)
          .then(function () {
            out.push('правка от актуальной ревизии: принята')
            return row()
          })
          .then(function (after) {
            out.push(`ревизия после принятой правки: ${after.revision}`)
          })
          .catch(function (error) {
            out.push(`правка от актуальной ревизии: отказ code=${error.code ?? 'нет'} :: ${String(error.message ?? error).slice(0, 120)}`)
          })
      })
      .then(function () {
        console.log('\n==== REVISION ====')
        console.log(out.join('\n'))
        console.log('==================')
        process.exit(0)
      })
      .catch(function (error) {
        console.log('\n==== REVISION ====')
        console.log('сбой зонда: ' + String(error && error.message ? error.message : error))
        console.log('==================')
        process.exit(0)
      })
  }, 1500)
}
