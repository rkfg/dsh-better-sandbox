/**
 * sandbox-allowlist / policy service.
 *
 * Владелец одной файловой политики харнесса, расширенной в три стороны:
 *   writableDirs   — дополнительные корни на ЗАПИСЬ вне cwd сессии;
 *   denySegments   — имена компонентов пути, которые нельзя писать (по умолчанию `.git`);
 *   readDenyDirs / readDenyFiles — пути, которые нельзя ЧИТАТЬ (ключи, личные данные).
 * Списки задаются в config строки профиля (cordis.patch.yml).
 *
 * Для чтения защита двухслойная: policy-fence в `fs.js` (отказ по пути для
 * инструментов и всех потребителей ctx.fs) и маска в `runner.js` (bind
 * каталога-нулёвки mode 000 в песочнице, откуда EACCES для любого процесса).
 *
 * @module dsh-sandbox-allowlist/allowlist
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, findProtectedUnder, segmentDenied } from './policy.js'

const pluginDir = dirname(fileURLToPath(import.meta.url))

/** Пути, которые харнесс читает сам: их защищать нельзя, иначе он ломает себя. */
const selfPaths = () => {
  const out = [process.cwd(), pluginDir]
  try {
    const packageDir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/cordis/package.json')))
    out.push(dirname(dirname(dirname(packageDir))))
  } catch {}
  return out.map(canonical).filter((path) => isAbsolute(path))
}

export default class SandboxAllowlist extends Service {
  // нужен для проверки путей (граница сессии) при правках из UI
  static inject = ['sandboxPolicy']

  // Страница настроек харнесса показывает только поля, помеченные .volatile().
  // Списки сейчас НЕ помечены: значение volatile-ссылки приходит из слоя
  // настроек, а не из patch, и запись через settings.write в проверке зависла —
  // то есть живой редактор правил ещё не готов. Списки читаются из config
  // строки профиля; rights-файл state.json перекрывает их на ходу.
  static Config = z.object({
    writableDirs: z.array(z.string()).default([]).volatile(),
    announceInPrompt: z.boolean().default(true),
    denySegments: z.array(z.string()).default(['.git']).volatile(),
    denyDepth: z.natural().default(3),
    denyScanTtlMs: z.natural().default(10_000),
    denySkipDirs: z.array(z.string()).default([
      'node_modules',
      '.git',
      '.hg',
      '.svn',
      'dist',
      'build',
      '.venv',
      '.cache',
      'target',
    ]),
    readDenyDirs: z.array(z.string()).default([]).volatile(),
    readDenyFiles: z.array(z.string()).default([]).volatile(),
    /** Если маску mode 000 создать не удалось: прятать каталог tmpfs'ом или не маскировать. */
    maskFallback: z.union(['tmpfs', 'skip']).default('tmpfs'),
    /** Дописывать «permission denied» в denial-сигнатуры раннера, чтобы отказ чтения показывался как политический. */
    readDenialSignature: z.boolean().default(true),
  })

  /** Эффективные списки — только через геттеры, объявленное поле перекроет геттер. */

  /** @type {Map<string, {at: number, paths: string[]}>} кэш обхода по корню */
  protectedCache = new Map()

  mask = { available: false, dir: void 0, file: void 0 }

  config

  /** Эффективные списки; перечитываются при обращении (см. syncLists). */
  lists = { roots: [], denySegments: [], readDirs: [], readFiles: [] }

  listsKey = null

  loggedSummary = null

  constructor(ctx, config) {
    super(ctx, 'sandboxAllowlist')
    this.config = config
    this.selfPaths = selfPaths()
    this.prepareMask()

    // Харнесс сообщает об обновлении volatile-полей событием loader/volatile-update.
    // Мемо по значениям остаётся основным механизмом (он не зависит от порядка
    // доставки), а подписка снимает лишние пересчёты при каждом обращении.
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      this.listsKey = null
    }), 'sandbox-allowlist: сброс мемо на volatile-update')
    this.syncLists()

    if (config.announceInPrompt) {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'sandbox:allowlist',
          order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
          text: () => {
            const lines = []
            if (this.roots.length > 0) {
              lines.push(
                `Additional write roots beyond the session workspace (workspace-write mode only): ${this.roots
                  .map((root) => JSON.stringify(root))
                  .join(', ')}.`,
              )
            }
            if (this.denySegments.length > 0) {
              lines.push(
                `Protected path names inside every writable root (workspace-write mode): ${this.denySegments
                  .map((segment) => JSON.stringify(segment))
                  .join(', ')} — writing there is refused the same way as writing outside the workspace, so escalate once with sandbox_permissions and a justification when the user genuinely needs it.`,
              )
            }
            const reads = [...this.readDirs, ...this.readFiles]
            if (reads.length > 0) {
              lines.push(
                `Protected from reading (secrets and personal data): ${reads
                  .map((path) => JSON.stringify(path))
                  .join(', ')} — reading their contents is refused for tools and denied inside sandboxed commands; escalate once with sandbox_permissions and a justification only when the user explicitly needs that file.`,
              )
            }
            return lines.join('\n')
          },
        })
      })
    }

    // ctx.effect ждёт setup, возвращающий disposer: очистка только при выгрузке.
    ctx.effect(() => () => {
      if (this.mask.dir !== void 0) try {
        chmodSync(this.mask.dir, 0o755)
      } catch {}
      try {
        rmSync(join(pluginDir, '.mask'), { recursive: true, force: true })
      } catch {}
    }, 'sandbox-allowlist mask')
  }

  /**
   * volatile-поля (списки правил) резолвятся только после конструирования
   * записи, поэтому списки перечитываются при обращении и пересобираются,
   * только когда изменился config или файл состояния.
   */
  syncLists() {
    const config = this.config
    const key = JSON.stringify([
      this.resolved(config.writableDirs),
      this.resolved(config.denySegments),
      this.resolved(config.readDenyDirs),
      this.resolved(config.readDenyFiles),
    ])
    const lists = {
      roots: this.collectDirs(this.liveList(config.writableDirs), this.selfPaths),
      denySegments: this.liveList(config.denySegments),
      readDirs: this.collectDirs(this.liveList(config.readDenyDirs), this.selfPaths),
      readFiles: this.collectFiles(this.liveList(config.readDenyFiles)),
    }
    this.lists = lists
    this.protectedCache.clear()

    const summary = JSON.stringify([lists.roots, lists.denySegments, lists.readDirs, lists.readFiles])
    if (summary !== this.loggedSummary) {
      this.loggedSummary = summary
      this.ctx.logger.info(`sandbox-allowlist: правила: корни ${JSON.stringify(lists.roots)}, защита по имени ${JSON.stringify(lists.denySegments)}, чтение закрыто ${JSON.stringify([...lists.readDirs, ...lists.readFiles])}, маска ${this.mask.available ? 'mode 000' : `fallback ${config.maskFallback}`}`)
    }
  }

  /** Значение volatile-поля до резолвинга приходит пустым узлом, а не списком. */
  /**
   * volatile-поля приходят ссылками { get() } (cosmokit), их значение меняется на
   * ходу без перемонтирования записи — поэтому значение берётся при обращении.
   */
  resolved(value) {
    return isVolatile(value) ? value.get() : value
  }

  liveList(value) {
    const resolved = this.resolved(value)
    return Array.isArray(resolved) ? resolved : []
  }


  get roots() {
    this.syncLists()
    return this.lists.roots
  }

  get denySegments() {
    this.syncLists()
    return this.lists.denySegments
  }

  get readDirs() {
    this.syncLists()
    return this.lists.readDirs
  }

  get readFiles() {
    this.syncLists()
    return this.lists.readFiles
  }

  collectDirs(entries, self) {
    const out = []
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.trim() === '') continue
      if (!isAbsolute(entry)) {
        this.ctx.logger.warn(`sandbox-allowlist: в readDenyDirs нужен абсолютный путь, пропущено ${JSON.stringify(entry)}`)
        continue
      }
      const path = canonical(resolve(entry))
      // Защита корня, из которого харнесс сам читает свой код и состояние,
      // ломает не агента, а сам харнесс.
      if (self.some((own) => path === own || (own.length > path.length && own.startsWith(`${path}/`)))) {
        this.ctx.logger.warn(`sandbox-allowlist: readDenyDirs ${JSON.stringify(path)} покрывает путь самого харнесса — пропущено`)
        continue
      }
      out.push(path)
    }
    return out
  }

  collectFiles(entries) {
    const out = []
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.trim() === '') continue
      if (!isAbsolute(entry)) {
        this.ctx.logger.warn(`sandbox-allowlist: в readDenyFiles нужен абсолютный путь, пропущено ${JSON.stringify(entry)}`)
        continue
      }
      out.push(canonical(resolve(entry)))
    }
    return out
  }

  /** Каталог и файл-нулёвка mode 000, которыми маска перекрывает защищённые пути. */
  /**
   * Нулёвки маски живут в папке плагина и могут исчезнуть во время работы
   * (например при переустановке пакета). Проверяем их по факту и восстанавливаем:
   * иначе bwrap падает целиком на «Can't find source path», и изоляция
   * отваливается у всех команд сразу.
   */
  maskUsable() {
    if (this.mask.dir !== void 0 && this.mask.file !== void 0 && existsSync(this.mask.dir) && existsSync(this.mask.file)) return true
    this.prepareMask()
    return this.mask.available === true && existsSync(this.mask.dir) && existsSync(this.mask.file)
  }

  prepareMask() {
    const root = join(pluginDir, '.mask')
    const dir = join(root, 'empty-dir')
    const file = join(root, 'empty-file')
    try {
      // Остаток прошлого запуска: каталог маски имеет режим 000, поэтому его
      // нельзя ни удалить, ни обойти — сначала вернуть права.
      for (const stale of [dir, root]) try {
        chmodSync(stale, 0o755)
      } catch {}
      try {
        chmodSync(join(root, 'empty-file'), 0o755)
      } catch {}
      rmSync(root, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o755 })
      writeFileSync(file, '', { mode: 0o644 })
      chmodSync(dir, 0o000)
      chmodSync(file, 0o000)
      this.mask = { available: true, dir, file }
    } catch (error) {
      this.ctx.logger.warn(`sandbox-allowlist: маска mode 000 не создана (${String(error)}), fallback: ${this.config.maskFallback}`)
      this.mask = { available: false, dir, file: existsSync(file) ? file : void 0 }
    }
  }




  /** Назначает списки без валидации (для загрузки сохранённого состояния). */


  /** Снимок для UI: списки, служебные ручки и состояние маски. */
  snapshot() {
    return {
      writableDirs: [...this.roots],
      denySegments: [...this.denySegments],
      readDenyDirs: [...this.readDirs],
      readDenyFiles: [...this.readFiles],
      mask: { available: this.mask.available, fallback: this.config.maskFallback },
      editable: true,
      scan: { depth: this.config.denyDepth, ttlMs: this.config.denyScanTtlMs, skipDirs: [...(this.config.denySkipDirs ?? [])] },
      reserved: [...this.selfPaths],
    }
  }

  /** Проверка пути до добавления: абсолютность, пересечение с самим харнессом, наличие. */
  validatePath(kind, path) {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'empty' }
    if (!isAbsolute(path)) return { ok: false, reason: 'relative' }
    const canonicalPathValue = canonical(resolve(path))
    if (kind === 'readDir') {
      for (const own of this.selfPaths) {
        if (canonicalPathValue === own || own.startsWith(`${canonicalPathValue}/`)) return { ok: false, reason: 'covers-harness', path: canonicalPathValue }
      }
      const root = this.ctx.sandboxPolicy.workspaceRoot
      if (typeof root === 'string' && root.startsWith(`${canonicalPathValue}/`)) return { ok: false, reason: 'covers-workspace', path: canonicalPathValue }
    }
    return { ok: true, path: canonicalPathValue, exists: existsSync(canonicalPathValue) }
  }

  /** Имя защищённого компонента, в котором лежит канонический путь, если есть. */
  deniedSegment(targetPath) {
    if (this.denySegments.length === 0) return void 0
    return segmentDenied(targetPath, this.denySegments)
  }

  /**
   * Попадает ли канонический путь под защиту от чтения.
   * @param key канонический путь цели.
   * @param allowDirRoot - `true` разрешает сам защищённый каталог (его существование
   *   не секрет), но всё внутри всё равно закрыто; для перечисления содержимого
   *   передавать `false`.
   */
  readDeniedFor(key, allowDirRoot = true) {
    if (typeof key !== 'string') return void 0
    if (this.readFiles.includes(key)) return this.readFiles[this.readFiles.indexOf(key)]
    for (const dir of this.readDirs) {
      if (key === dir) {
        if (allowDirRoot) continue
        return dir
      }
      if (key.startsWith(`${dir}/`)) return dir
    }
    return void 0
  }

  /** Существующие защищённые от записи пути под перечисленными корнями (кэшированный обход). */
  protectedUnder(roots) {
    const found = new Set()
    for (const root of roots) {
      for (const path of findProtectedUnder(
        root,
        this.denySegments,
        this.config.denyDepth ?? 3,
        this.config.denySkipDirs ?? [],
        this.config.denyScanTtlMs ?? 10_000,
        this.protectedCache,
      )) {
        found.add(path)
      }
    }
    return [...found]
  }
}
