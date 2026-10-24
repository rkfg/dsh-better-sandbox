/**
 * Драйвер-проверка: вызывает те же seams, что и инструменты (ctx.fs.readText /
 * listDir / stat / writeText, ctx.sandbox.confine + spawn), и печатает исходы.
 * Отдельно отмечается, попал ли отказ в denial-сигнатуру раннера — только тогда
 * инструмент bash показывает политический маркер с подсказкой об эскалации.
 *
 * @module dsh-sandbox-allowlist/driver
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'sandbox-allowlist-driver'
export const inject = ['fs', 'sandboxPolicy', 'sandbox', 'subprocess']

const readAll = (handle, stream) => handle.collected?.[stream]?.readFrom(0)?.text ?? ''

const DENIAL_SIGNATURES = ['read-only file system', 'permission denied', 'operation not permitted']

const WRITE_CASES = [
  ['fs write inside-cwd', 'normal/probe.txt'],
  ['fs write .git', '.git/fs-probe.txt'],
  ['fs write allowed dir', '../allowed/fs-probe.txt'],
  ['fs write denied dir', '../denied/fs-probe.txt'],
]

const READ_CASES = [
  ['fs read normal file', 'normal/probe.txt', 'readText', true],
  ['fs read secret file in dir', 'secretdir/id_rsa', 'readText', false],
  ['fs list secret dir', 'secretdir', 'listDir', false],
  ['fs stat secret file', 'secretdir/id_rsa', 'stat', false],
  ['fs read secret file direct', '../secretfile.txt', 'readText', false],
  ['fs read bytes of secret', 'secretdir/id_rsa', 'readBytes', false],
]

const BASH_CASES = [
  ['bash read .git/HEAD', 'cat "$1" >/dev/null'],
  ['bash write into .git', 'printf x > "$2/.git/bash-probe.txt"'],
  ['bash git commit', 'git -C "$2" -c user.email=t@t -c user.name=t commit -m t --allow-empty'],
  ['bash cat secret file in dir', 'cat "$5"'],
  ['bash ls secret dir', 'ls "$6"'],
  ['bash cat secret file', 'cat "$7"'],
  ['bash touch inside secret dir', 'touch "$6/attempt.txt"'],
  ['bash cat normal file', 'cat "$8"'],
]

const RG_CASES = [
  ['rg --files inside secret dir', ['--files', 'secretdir']],
  ['rg search secret content', ['-e', 'СЕКРЕТ', 'secretdir']],
  ['rg --files cwd (регрессия)', ['--files', 'normal']],
]

const pathOf = (cwd, rel) => new URL(`file://${cwd}/${rel}`).pathname

export async function apply(ctx) {
  const cwd = process.cwd()
  const allow = ctx.get('sandboxAllowlist')
  const guard = ctx.get('sandboxGuard')
  const policy = ctx.sandboxPolicy.resolve()
  const out = []
  out.push(`policy: mode=${policy.mode} root=${policy.workspaceRoot}`)
  out.push(`write roots: ${JSON.stringify(allow?.roots ?? null)}, denySegments: ${JSON.stringify(allow?.denySegments ?? null)}`)
  out.push(`readDenyDirs: ${JSON.stringify(allow?.readDirs ?? null)}, readDenyFiles: ${JSON.stringify(allow?.readFiles ?? null)}, mask: ${allow?.mask?.available ? '000' : 'fallback'}`)
  out.push(`тильда раскрыта: ${JSON.stringify((allow?.roots ?? []).filter((root) => root.includes('/.cache')))}, отброшено/подозрительно: ${JSON.stringify(allow?.rejected ?? null)}`)

  // фикстуры: репозиторий, вложенный репозиторий, «секреты»
  mkdirSync(`${cwd}/normal`, { recursive: true })
  mkdirSync(`${cwd}/secretdir/sub`, { recursive: true })
  writeFileSync(`${cwd}/normal/probe.txt`, 'обычное содержимое\n')
  writeFileSync(`${cwd}/secretdir/id_rsa`, 'СЕКРЕТНЫЙ КЛЮЧ\n')
  writeFileSync(`${cwd}/secretdir/sub/nested`, 'СЕКРЕТ ВО ВЛОЖЕННОМ\n')
  writeFileSync(`${cwd}/../secretfile.txt`, 'СЕКРЕТНЫЙ ФАЙЛ\n')
  spawnSync('git', ['init', '-q', cwd], { stdio: 'ignore' })
  spawnSync('git', ['init', '-q', `${cwd}/sub`], { stdio: 'ignore' })

  for (const [label, rel] of WRITE_CASES) {
    const path = pathOf(cwd, rel)
    try {
      await ctx.fs.writeText(await ctx.fs.resolve(path), 'ok\n', void 0, void 0, policy)
      out.push(`${label}: WROTE`)
    } catch (error) {
      out.push(`${label}: DENIED ${error.code ?? error.name}`)
    }
  }

  for (const [label, rel, method, expectOk] of READ_CASES) {
    const target = await ctx.fs.resolve(pathOf(cwd, rel))
    try {
      if (method === 'readText') await ctx.fs.readText(target)
      else if (method === 'listDir') await ctx.fs.listDir(target)
      else if (method === 'stat') await ctx.fs.stat(target)
      else await ctx.fs.readBytes(target, void 0, 1024)
      out.push(`${label}: ПРОЧИТАНО${expectOk ? '' : ' (ожидался отказ!)'}`)
    } catch (error) {
      out.push(`${label}: DENIED ${error.code ?? error.name}`)
    }
  }

  const args = [
    'bash',
    '-c',
    '',
    '_',
    `${cwd}/.git/HEAD`,
    cwd,
    `${cwd}/../allowed/bash-probe.txt`,
    `${cwd}/../denied/bash-probe.txt`,
    `${cwd}/secretdir/id_rsa`,
    `${cwd}/secretdir`,
    `${cwd}/../secretfile.txt`,
    `${cwd}/normal/probe.txt`,
  ]
  for (const [label, spec] of BASH_CASES) {
    args[2] = spec
    const confined = await ctx.sandbox.confine(args, policy)
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', cwd })
    const stderr = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase()
    const signatures = confined.denialSignatures ?? DENIAL_SIGNATURES
    out.push(
      `${label}: exit=${result.status} denial-signature=${signatures.some((signature) => stderr.includes(signature))} :: ${stderr.trim().replace(/\n/g, ' | ').slice(-90)}`,
    )
  }
  // регресс: нулёвки маски стёрты внешним процессом (так делает переустановка
  // пакета) — confine обязан остаться рабочим, а маска должна восстановиться сама
  const maskDir = allow?.mask?.dir
  if (maskDir === void 0) {
    out.push('маска не создавалась — регресс маски пропущен')
  } else {
    // снимаем сами нулёвки: rmdir каталога 000 не требует доступа внутрь него,
    // поэтому это тот же исход, что при удалении папки пакета целиком
    try { chmodSync(maskDir, 0o755) } catch {}
    rmSync(maskDir, { recursive: true, force: true })
    if (allow.mask.file !== void 0) rmSync(allow.mask.file, { force: true })
    out.push(`внешнее удаление нулёвок: маска существует=${existsSync(maskDir)}`)
    const after = [...args]
    after[2] = `touch ${cwd}/.git/post-mask-probe.txt`
    const confined = await ctx.sandbox.confine(after, policy)
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8', cwd })
    const stderr = `${result.stdout ?? ''}${result.stderr ?? ''}`.toLowerCase()
    out.push(
      `команда без нулёвок: exit=${result.status} отказ-bwrap=${stderr.includes("can't find source path")} :: ${stderr.trim().replace(/\n/g, ' | ').slice(-80)}`,
    )
    out.push(`самовосстановление маски: существует=${existsSync(maskDir)}`)
  }

  // проверки правил имеют смысл только когда плагин подключён: basetest идёт
  // против базовых провайдеров харнесса, и там их просто нет
  if (allow === void 0 || guard === void 0) {
    out.push('плагин не подключён: проверки правил пропущены')
  } else {
    // регресс: effective-списки берутся из config, файл состояния больше не должен
    // перекрывать их (именно он прятал правку со страницы настроек)
    const state = guard.state()
    const expected = String(ctx.sandboxPolicy.workspaceRoot)
    out.push(`sandboxGuard.state(): readDenyDirs=${JSON.stringify(state.readDenyDirs)}, writableDirs=${JSON.stringify(state.writableDirs)}, mask=${state.mask.available ? '000' : state.mask.fallback}`)
    const pluginSidecar = join(dirname(fileURLToPath(import.meta.url)), 'state.json')
    out.push(`файл состояния не создаётся: ${!existsSync(pluginSidecar)}`)
    const listed = state.readDenyDirs.length > 0 && state.readDenyDirs.some((dir) => dir.endsWith('secretdir'))
    out.push(`правила из config видны сразу: ${listed}`)
    let remoteCode = 'нет ошибки'
    try {
      guard.validate('bogus-kind', '/tmp/x')
    } catch (error) {
      remoteCode = `${error.code ?? 'БЕЗ КОДА'}: ${String(error.message).slice(0, 40)}`
    }
    out.push(`Remote-отказ validate: ${remoteCode}`)
    const rejected = allow.validatePath('readDir', expected)
    out.push(`validate covers-workspace: ${rejected.ok ? 'НЕ отклонён (ожидался отказ!)' : rejected.reason}`)

  }

  const rgPath = await (await import('@vscode/ripgrep')).rgPath
  for (const [label, rgArgs] of RG_CASES) {
    const handle = ctx.subprocess.spawn({
      argv: [rgPath, '--no-config', ...rgArgs.map((arg) => (arg === 'secretdir' || arg === 'normal' ? `${cwd}/${arg}` : arg))],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 500,
    })
    const settled = await handle.done
    const text = `${await readAll(handle, 'stdout')}${await readAll(handle, 'stderr')}`
    out.push(`${label}: exit=${settled.exitCode} :: ${text.trim().replace(/\n/g, ' | ').slice(0, 110)}`)
  }
  console.log('\n==== RESULT ====\n' + out.join('\n') + '\n================')
  process.exit(0)
}
