export const name = 'loader-probe'
export const inject = ['loader']
export async function apply(ctx) {
  const rows = []
  for (const entry of ctx.loader.entries()) {
    const id = entry.options?.id ?? '(нет id)'
    const name = typeof entry.options?.name === 'string' ? entry.options.name : '(нет имени)'
    let tree = '?'
    try { tree = entry.parent?.tree?.ctx?.fiber?.entry?.options?.id ?? entry.parent?.tree?.ctx?.fiber?.entry?.name ?? '?' } catch {}
    const kind = entry.fiber?.entry?.name ?? entry.fiber?.type ?? '?'
    rows.push(`${id} | name=${name} | дерево=${tree} | тип=${kind}`)
  }
  console.log('\n==== LOADER ====')
  console.log(`записей: ${rows.length}`)
  for (const row of rows) if (/sandbox|mnemon|include|base|web-app/i.test(row)) console.log(row)
  console.log('==============')
  process.exit(0)
}
