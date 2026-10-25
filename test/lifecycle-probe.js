// Lifecycle probe: the mask stubs are the resource a confinement reads after an `await`,
// so unloading the row has to wait for the commands it already accepted, and a command
// accepted during the unload must not leave a rebuilt pair of mode-000 stubs behind.
//
// The probe drives the real entries inside a private cordis context, so the profile's own
// providers stay untouched; the stubs it watches are the ones the copied module folder owns.
export const name = 'lifecycle-probe'

import { Context, Service } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import BetterSandbox from './rules.js'
import BetterSandboxProvider from './runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const maskRoot = join(here, '.mask')
const stubDir = join(maskRoot, 'empty-dir')
const stubFile = join(maskRoot, 'empty-file')
const runDir = realpathSync.native(process.cwd())
const secretFile = join(runDir, 'lifecycle-secret.txt')

const releaseStubs = () => {
  for (const path of [stubDir, stubFile]) {
    try {
      const info = lstatSync(path)
      if (info.isSymbolicLink()) rmSync(path, { force: true })
      else chmodSync(path, 0o755)
    } catch {}
  }
  rmSync(maskRoot, { recursive: true, force: true })
}

const stubsPresent = () => existsSync(stubDir) || existsSync(stubFile)
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The source the confinement binds over one protected path, or `''` when it binds nothing. */
const boundOver = (argv, path) => {
  for (let at = 0; at + 2 < argv.length; at += 1) {
    if (argv[at] === '--ro-bind' && argv[at + 2] === path) return argv[at + 1]
  }
  return ''
}

/** The session boundary the entries ask for; the probe supplies its own. */
class ProbePolicy extends Service {
  constructor(ctx) {
    super(ctx, 'sandboxPolicy')
    this.workspaceRoot = runDir
  }
  resolve() {
    return { mode: 'workspace-write', workspaceRoot: runDir }
  }
}

const POLICY = { mode: 'workspace-write', workspaceRoot: runDir }

/** Stands for the bash-tool fiber: it requires `sandbox` and calls confine from its own context. */
function toolFiber(ctx, sink) {
  return ctx.plugin({
    name: 'lifecycle-consumer',
    inject: ['sandbox'],
    apply(scope) {
      sink.confine = () => scope.sandbox.confine(['bash', '-c', 'true'], POLICY)
    },
  })
}

async function boot() {
  releaseStubs()
  writeFileSync(secretFile, 'read me not\n')
  const ctx = new Context()
  ctx.plugin(ProbePolicy)
  const rules = ctx.plugin(BetterSandbox, {
    denySegments: ['.git'],
    readDenyFiles: [secretFile],
    announceInPrompt: false,
  })
  const runner = ctx.plugin(BetterSandboxProvider)
  await rules
  await runner
  return { ctx, rules, runner }
}

const out = []

// 1. The plain unload still removes the stubs.
{
  const { rules } = await boot()
  const before = stubsPresent()
  await rules.dispose()
  await settle(30)
  out.push(`plain unload: stubs before=${before ? 'yes' : 'no'}, after=${stubsPresent() ? 'LEFT' : 'gone'}`)
}

// 2. The race: a confine accepted while the row is unloading keeps its mask, and the
//    disposer that already ran does not get a rebuilt pair of stubs behind it.
{
  const { ctx, rules } = await boot()
  const sink = {}
  const tool = toolFiber(ctx, sink)
  await tool
  const disposal = rules.dispose()
  // The same tick the unload starts in: the confinement is accepted while its owner is
  // still mounted, and it reads the mask stubs only after its own await.
  let verdict = 'threw'
  let source = ''
  try {
    source = boundOver((await sink.confine()).argv, secretFile)
    verdict = 'ok'
  } catch {}
  await disposal
  await settle(30)
  const masked = source === stubFile
  out.push(`confine accepted during unload: confine=${verdict}, secret masked by the stub=${masked ? 'yes' : 'no'}, stubs after disposal=${stubsPresent() ? 'LEFT' : 'gone'}`)
}

// 3. Teardown reaches quiescence: while a confinement holds the owner, the unload waits;
//    it settles once the confinement is built, and only then do the files go.
{
  const { ctx, rules } = await boot()
  const owner = ctx.get('betterSandbox')
  if (typeof owner.lease !== 'function') {
    out.push('unload waits for an admitted confinement: no lease on the owner, teardown cannot wait for one')
  } else {
    const lease = owner.lease()
    const disposal = rules.dispose()
    await settle(40)
    const pendingWhileHeld = stubsPresent()
    lease.release()
    await disposal
    await settle(30)
    out.push(`unload waits for an admitted confinement: stubs while held=${pendingWhileHeld ? 'kept' : 'gone too early'}, after release=${stubsPresent() ? 'LEFT' : 'gone'}`)
  }
}

// 4. After the unload a late reader gets the fallback, not a new pair of stubs.
{
  const { ctx, rules } = await boot()
  const owner = ctx.get('betterSandbox')
  await rules.dispose()
  await settle(30)
  const usable = owner.maskUsable()
  await settle(10)
  out.push(`after unload: maskUsable=${usable}, stubs recreated=${stubsPresent() ? 'yes' : 'no'}`)
}

const clean = out.every((line) => !/(LEFT|gone too early|recreated=yes|threw|stub=no|maskUsable=true)/.test(line))
out.push(`lifecycle: ${clean ? 'OK' : 'FAILED'}`)

rmSync(secretFile, { force: true })
releaseStubs()
console.log('\n==== RESULT ====\n' + out.join('\n') + '\n================')
process.exit(clean ? 0 : 1)
