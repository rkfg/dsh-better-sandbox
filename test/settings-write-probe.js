export const name = 'settings-write-probe'
export const inject = ['settings', 'sandboxAllowlist', 'fs']

// Вызов из apply() deadlock-ится: settings.update перезагружает слои профиля и
// ждёт, пока завершится fiber вызывающей записи. Поэтому запись — вне стека
// активации, по таймеру.
export async function apply(ctx) {
  const secret = `${process.cwd()}/secretdir/nested`
  setTimeout(() => {
    const run = async () => {
      console.log('\n==== WRITE ====')
      const rows = await ctx.settings.describe()
      const mine = rows.find((row) => row.ns === 'sandbox-allowlist')
      console.log(`страница есть=${Boolean(mine)} revision=${mine?.revision} поля=${JSON.stringify(Object.keys(mine?.value ?? {}))}`)
      console.log('до: readDirs=' + JSON.stringify(ctx.sandboxAllowlist.readDirs))
      try {
        const result = await ctx.settings.update('sandbox-allowlist', { readDenyDirs: [secret] })
        console.log('update: ок ' + JSON.stringify(result ?? null).slice(0, 120))
      } catch (error) {
        console.log('update не удался: ' + String(error?.message ?? error).slice(0, 200))
      }
      await new Promise((resolve) => setTimeout(resolve, 1200))
      console.log('после: readDirs=' + JSON.stringify(ctx.sandboxAllowlist.readDirs))
      for (const [label, file] of [['старый каталог (больше не закрыт)', 'secretdir/k.txt'], ['новый каталог (только что закрыт)', 'secretdir/nested/k2.txt']]) {
        const target = await ctx.fs.resolve(`${process.cwd()}/${file}`)
        try {
          await ctx.fs.readText(target)
          console.log(`чтение ${label}: ПРОЧИТАНО`)
        } catch (error) {
          console.log(`чтение ${label}: DENIED ${error.code ?? error.name} :: ${String(error.message).slice(0, 90)}`)
        }
      }
      const locRows = await ctx.settings.describe()
      const loc = locRows.find((row) => row.ns === 'locale')
      console.log('locale value: ' + JSON.stringify(loc?.value ?? null).slice(0, 200))
      if (loc !== void 0) {
        const key = Object.keys(loc.value ?? {}).find((name) => typeof loc.value[name] === 'string')
        if (key === void 0) console.log('locale: нет строкового поля для языка')
        else {
          try {
            await ctx.settings.update('locale', { [key]: 'zh' }, loc.revision)
            console.log(`locale: ${key} → zh (ок)`)
          } catch (error) {
            console.log(`locale: запись не удалась — ${String(error?.message ?? error).slice(0, 120)}`)
          }
        }
      }
      console.log('============')
    }
    run()
  }, 4000)
}
