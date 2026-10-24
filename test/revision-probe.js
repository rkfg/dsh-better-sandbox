// Probe for the settings layer's revision counter: why update() accepts only an edit made
// against the current snapshot, not just any edit. The call runs on a timer, outside the
// entry's activation stack: config-editor takes a lock on the profile's package.json, which
// the startup pass is holding, so calling straight from apply() hits the lock timeout.
//
//   DSH_PROBE=revision ./scripts/webfull.sh
export const name = 'revision-probe'
export const inject = ['settings']

export function apply(ctx) {
  setTimeout(function () {
    const out = []
    const row = function () {
      return Promise.resolve(ctx.settings.describe()).then(function (rows) {
        return rows.find(function (entry) { return entry.ns === 'better-sandbox' })
      })
    }
    row()
      .then(function (first) {
        out.push(`document revision: ${first.revision}, fields in value: ${Object.keys(first.value ?? {}).length}`)
        // An edit made from a stale snapshot: this is what a second browser looks like, one
        // still holding the value from before the profile was changed somewhere else.
        return ctx.settings.update('better-sandbox', { denySegments: ['.git'] }, first.revision + 1000)
          .then(function () {
            out.push('stale revision: ACCEPTED (a rejection was expected — someone else\'s edit would have been lost)')
          })
          .catch(function (error) {
            out.push(`stale revision: rejected code=${error.code ?? 'none'} :: ${String(error.message ?? error).slice(0, 120)}`)
          })
      })
      .then(function () {
        return row()
      })
      .then(function (fresh) {
        out.push(`revision after the rejection: ${fresh.revision} (unchanged)`)
        return ctx.settings.update('better-sandbox', { denySegments: fresh.value.denySegments ?? ['.git'] }, fresh.revision)
          .then(function () {
            out.push('edit against the current revision: accepted')
            return row()
          })
          .then(function (after) {
            out.push(`revision after the accepted edit: ${after.revision}`)
          })
          .catch(function (error) {
            out.push(`edit against the current revision: rejected code=${error.code ?? 'none'} :: ${String(error.message ?? error).slice(0, 120)}`)
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
        console.log('probe failure: ' + String(error && error.message ? error.message : error))
        console.log('==================')
        process.exit(0)
      })
  }, 1500)
}
