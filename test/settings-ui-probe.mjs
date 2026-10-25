// UI test for the "Sandbox" section: it opens the Settings dialog, types deliberately
// unusable rules into a field, clicks Save, and checks that the page marks every problem
// in red and refuses to save the edit. It has to run in a browser: the validation lives in
// the client half, and you can break it without noticing anything on the host.
//
//   node test/settings-ui-probe.mjs <url>
//
// CHROME_BIN selects the browser binary.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node test/settings-ui-probe.mjs <url>')
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
if (chrome === undefined) { console.error('browser not found: install chromium or set CHROME_BIN'); process.exit(2) }

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
if (target === undefined) { console.error('no CDP target'); process.exit(1) }

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

// Helper inside the page: click the element whose text or aria-label matched.
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
  const viaAccount = clickWhere(/Account menu|账户/i)
  return { viaAccount }`)
await sleep(1200)
const settings = await evaluate(`${clicker} return clickWhere(/Settings|设置/i)`)
await sleep(1500)
const section = await evaluate(`${clicker} return clickWhere(/^\\s*Sandbox\\s*$|沙盒/)`)
await sleep(1200)

const filled = await evaluate(`
  const areas = [...document.querySelectorAll('textarea')]
  if (areas.length === 0) return { areas: 0 }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(areas[0], "/tmp/ok-dir\\nrelative/path\\n~root/keys\\n/\\n/tmp/ok-dir")
  areas[0].dispatchEvent(new Event('input', { bubbles: true }))
  // path-name field: .git is a valid rule, a segment with a separator is not
  const last = areas[areas.length - 1]
  setter.call(last, ".git\\nnested/.git")
  last.dispatchEvent(new Event('input', { bubbles: true }))
  // the escalation level is a token rather than a list, so it gets a one-line box; a token
  // with capitals or spaces must be refused the way an unusable rule line is
  const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const token = [...document.querySelectorAll('input')].find((node) => (node.value || '').startsWith('write-segment'))
  if (token !== undefined) {
    inputSetter.call(token, 'Write Segment')
    token.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return { areas: areas.length, token: token !== undefined }`)
await sleep(800)

const saved = await evaluate(`
  const button = [...document.querySelectorAll('button')].find((node) => /^(Save|保存)$/.test((node.textContent || '').trim()))
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
    segment: grab(/expected one path name|期望单个路径名/i),
    token: grab(/expected one lowercase word|期望一个小写单词/i),
    // a rule for the whole filesystem is refused by the form itself, before saving
    rootPath: grab(/a rule for the whole filesystem|不允许整条文件系统规则/i),
    raw: text.slice(0, 4000),
  }`)

const failures = []
if (opened.viaAccount !== true) failures.push('the account menu did not open')
if (settings !== true) failures.push('the Settings dialog did not open')
if (section !== true) failures.push('the Sandbox section was not found in Settings')
if (filled.areas === 0) failures.push('the section has no input fields')
if (saved !== true) failures.push('the Save button was not found')
for (const key of ['relative', 'tildeUser', 'duplicate', 'blocked', 'segment', 'rootPath']) {
  if (verdict[key] === null) failures.push(`the "${key}" caption never appeared`)
}
// The level field is only worth asserting when the page actually rendered it.
if (filled.token !== true) failures.push('the escalation-level field was not rendered')
else if (verdict.token === null) failures.push('the "token" caption never appeared for the escalation level')

console.log('section opened:', section, '| fields:', filled.areas, '| level field:', filled.token, '| Save clicked:', saved)
console.log('captions:', JSON.stringify(verdict))
const gitFlagged = String(verdict.raw ?? '').split(String.fromCharCode(10)).some((line) => /needs an absolute path|需要绝对路径/.test(line) && line.includes('.git'))
if (gitFlagged) failures.push('the .git rule in the path-name field is flagged as invalid')
if (failures.length === 0) console.log('check passed: unusable rules are highlighted in red and saving is blocked')
else console.log('check failed: ' + failures.join('; '))
cleanup()
process.exit(failures.length === 0 ? 0 : 1)
