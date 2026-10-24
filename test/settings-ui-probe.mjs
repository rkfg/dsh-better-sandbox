// UI-тест раздела «Sandbox»: открывает диалог настроек, вписывает в поле заведомо
// непригодные правила, нажимает Save и проверяет, что страница показала красным
// каждую проблему и не сохранила правку. Нужен именно прогон в браузере: проверка
// живёт в клиентской половине, и сломать её можно не заметив на хосте.
//
//   node test/settings-ui-probe.mjs <url>
//
// Переменная CHROME_BIN задаёт бинарь браузера.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
if (url === undefined) {
  console.error('использование: node test/settings-ui-probe.mjs <url>')
  process.exit(2)
}

const candidates = [process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].filter(Boolean)
const profileDir = new URL('../.dsh-test/chrome-cdp-ui/', import.meta.url).pathname
const port = Number(process.env.CDP_PORT ?? 9334)

let chrome
for (const bin of candidates) {
  try {
    chrome = spawn(bin, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, 'about:blank',
    ], { stdio: 'ignore' })
    break
  } catch {}
}
if (chrome === undefined) { console.error('браузер не найден: установите chromium или задайте CHROME_BIN'); process.exit(2) }

const cleanup = () => { try { chrome.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

let target
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(250)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = list.find((entry) => entry.type === 'page')
    if (target !== undefined) break
  } catch {}
}
if (target === undefined) { console.error('CDP-цель не получена'); process.exit(1) }

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  pending.delete(message.id)
  if (entry !== undefined) {
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result?.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url })
await sleep(7000)

// Помощник внутри страницы: клик по элементу, чей текст или aria-label совпал.
const clicker = `
  const clickWhere = (matcher) => {
    const nodes = [...document.querySelectorAll('button,[role=button],a,[role=menuitem],[role=tab]')]
    const hit = nodes.find((node) => matcher.test((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '')))
    if (hit === undefined) return false
    hit.click()
    return true
  }
`

const opened = await evaluate(`${clicker}
  const viaAccount = clickWhere(/Account menu|Учётная запись|账户/i)
  return { viaAccount }`)
await sleep(1200)
const settings = await evaluate(`${clicker} return clickWhere(/Settings|Настройки|设置/i)`)
await sleep(1500)
const section = await evaluate(`${clicker} return clickWhere(/^\\s*Sandbox\\s*$|沙盒/)`)
await sleep(1200)

const filled = await evaluate(`
  const areas = [...document.querySelectorAll('textarea')]
  if (areas.length === 0) return { areas: 0 }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(areas[0], "/tmp/ok-dir\\nrelative/path\\n~root/keys\\n/tmp/ok-dir")
  areas[0].dispatchEvent(new Event('input', { bubbles: true }))
  return { areas: areas.length }`)
await sleep(800)

const saved = await evaluate(`
  const button = [...document.querySelectorAll('button')].find((node) => /^(Save|Сохранить|保存)$/.test((node.textContent || '').trim()))
  if (button === undefined) return false
  button.click()
  return true`)
await sleep(900)

const verdict = await evaluate(`
  const text = document.body.innerText
  const grab = (pattern) => (text.match(pattern) || [null])[0]
  return {
    relative: grab(/needs an absolute path|需要绝对路径/i),
    tildeUser: grab(/~user form is not supported|不支持 ~user/i),
    duplicate: grab(/repeated rule|规则重复/i),
    blocked: grab(/some lines are unusable|部分条目无法使用/i),
  }`)

const failures = []
if (opened.viaAccount !== true) failures.push('не открылось меню учётной записи')
if (settings !== true) failures.push('не открылся диалог настроек')
if (section !== true) failures.push('не найден раздел Sandbox в настройках')
if (filled.areas === 0) failures.push('в разделе нет полей ввода')
if (saved !== true) failures.push('не найдена кнопка Save')
for (const key of ['relative', 'tildeUser', 'duplicate', 'blocked']) {
  if (verdict[key] === null) failures.push(`под подпись «${key}» не появилась`)
}

console.log('открыт раздел:', section, '| полей:', filled.areas, '| нажато Save:', saved)
console.log('подписи:', JSON.stringify(verdict))
if (failures.length === 0) console.log('проверка пройдена: непригодные правила подсвечены красным, сохранение заблокировано')
else console.log('проверка провалена: ' + failures.join('; '))
cleanup()
process.exit(failures.length === 0 ? 0 : 1)
