export const name = 'settings-write-probe'
export const inject = ['settings', 'sandboxAllowlist', 'fs']

// Calling from apply() would deadlock: settings.update reloads the profile layers and
// waits for the fiber of the calling entry to finish. That is why the write happens
// outside the activation stack, on a timer.
export async function apply(ctx) {
  const secret = `${process.cwd()}/secretdir/nested`
  setTimeout(() => {
    const run = async () => {
      console.log('\n==== WRITE ====')
      const rows = await ctx.settings.describe()
      const mine = rows.find((row) => row.ns === 'sandbox-allowlist')
      console.log(`page present=${Boolean(mine)} revision=${mine?.revision} fields=${JSON.stringify(Object.keys(mine?.value ?? {}))}`)
      console.log('before: readDirs=' + JSON.stringify(ctx.sandboxAllowlist.readDirs))
      try {
        const result = await ctx.settings.update('sandbox-allowlist', { readDenyDirs: [secret] })
        console.log('update: ok ' + JSON.stringify(result ?? null).slice(0, 120))
      } catch (error) {
        console.log('update failed: ' + String(error?.message ?? error).slice(0, 200))
      }
      await new Promise((resolve) => setTimeout(resolve, 1200))
      console.log('after: readDirs=' + JSON.stringify(ctx.sandboxAllowlist.readDirs))
      for (const [label, file] of [['old directory (no longer read-protected)', 'secretdir/k.txt'], ['new directory (just read-protected)', 'secretdir/nested/k2.txt']]) {
        const target = await ctx.fs.resolve(`${process.cwd()}/${file}`)
        try {
          await ctx.fs.readText(target)
          console.log(`read ${label}: READ`)
        } catch (error) {
          console.log(`read ${label}: DENIED ${error.code ?? error.name} :: ${String(error.message).slice(0, 90)}`)
        }
      }
      const locRows = await ctx.settings.describe()
      const loc = locRows.find((row) => row.ns === 'locale')
      console.log('locale value: ' + JSON.stringify(loc?.value ?? null).slice(0, 200))
      if (loc !== void 0) {
        const key = Object.keys(loc.value ?? {}).find((name) => typeof loc.value[name] === 'string')
        if (key === void 0) console.log('locale: no string field for the language')
        else {
          try {
            await ctx.settings.update('locale', { [key]: 'zh' }, loc.revision)
            console.log(`locale: ${key} → zh (ok)`)
          } catch (error) {
            console.log(`locale: write failed — ${String(error?.message ?? error).slice(0, 120)}`)
          }
        }
      }
      console.log('============')
    }
    run()
  }, 4000)
}
