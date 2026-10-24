// Зонд загрузки страницы: грузит тестовый веб-профиль в headless-браузере и
// проверяет, что клиентская половина собралась. Плагин может быть полностью
// работоспособен на хосте и при этом обрывать загрузку SPA — например когда id
// клиентского модуля не совпадает с именем пакета, загрузчик модулей падает с
// «duplicate factory registration», а страница показывает «Failed to load
// plugins». Хост-логи об этом молчат, поэтому проверка ведётся по консоли.
//
//   node test/page-probe.mjs <url>
//
// Переменная CHROME_BIN задаёт бинарь браузера (chromium, google-chrome, …).
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
if (url === undefined) {
  console.error('использование: node test/page-probe.mjs <url>')
  process.exit(2)
}

const candidates = [process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].filter(Boolean)
const profileDir = new URL('../.dsh-test/chrome-cdp/', import.meta.url).pathname
const port = Number(process.env.CDP_PORT ?? 9333)
const fatal = /did not activate|duplicate factory registration|client-modules:|Failed to load plugins|import failed|Uncaught/i

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
if (target === undefined) { console.error('CDP-цель не получена: браузер не поднялся'); process.exit(1) }

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const failures = []
const note = (text) => {
  if (fatal.test(text) && !failures.some((row) => row.slice(0, 120) === text.slice(0, 120))) failures.push(text)
}

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (entry !== undefined) {
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    note((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails
    note(detail?.exception?.description ?? detail?.text ?? 'exception')
  }
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url })
await sleep(Number(process.env.PAGE_WAIT_MS ?? 9000))

const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 400)', returnByValue: true })
const body = String(text.result?.value ?? '')
if (/Failed to load plugins/i.test(body)) note(`страница показала экран отказа: ${body.slice(0, 160)}`)

console.log(failures.length === 0 ? 'страница загрузилась: отказов в консоли нет' : `страница не загрузилась, отказов: ${failures.length}`)
for (const row of failures) console.log(`  ${row.slice(0, 220)}`)
cleanup()
process.exit(failures.length === 0 ? 0 : 1)
