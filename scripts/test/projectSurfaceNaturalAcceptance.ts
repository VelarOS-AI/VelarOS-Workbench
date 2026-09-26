/** Production-account / production-stack acceptance. Run only on an explicit disposable Git worktree. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { ExecutionEventBus } from '@velaros-ai/agent'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

import { WorkbenchAccountService } from '../../src/main/account/WorkbenchAccountService'
import { WorkbenchSharedAccountStore } from '../../src/main/account/WorkbenchSharedAccountStore'
import { ProjectRecoverySeed } from './projectRecoverySeed'

const command = promisify(execFile)
const { values } = parseArgs({ options: {
  'check-models': { type: 'boolean' },
  worktree: { type: 'string' },
  'task-file': { type: 'string' },
  'output-parent': { type: 'string' },
  provider: { type: 'string', default: 'velar-dev' },
  model: { type: 'string', default: 'gpt-5.6-sol' },
  'fixture-label': { type: 'string' },
  'recovery-seed': { type: 'string' },
  'timeout-ms': { type: 'string', default: '900000' },
  'max-model-requests': { type: 'string', default: '40' },
} })

assert(values.provider === 'velar' || values.provider === 'velar-dev', 'provider must be velar or velar-dev')
const providerId = values.provider
const account = new WorkbenchAccountService(new WorkbenchSharedAccountStore(), async () => {
  throw new Error('Acceptance requires the existing signed-in account.')
})

/** Do not persist headers, account objects or provider credentials in an acceptance artifact. */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, /authorization|api.?key|access.?token|refresh.?token|password|credential|cookie/iu.test(key) ? '[redacted]' : sanitize(item),
  ]))
  return typeof value === 'bigint' ? value.toString() : value
}
function json(value: unknown) { return JSON.stringify(sanitize(value), null, 2) }

const access = await account.getManagedModelAccess()
const available = access.managedModels.map((entry) => ({ provider: entry.providerId, enabled: entry.enabled, models: entry.models.map((model) => ({ id: model.id, status: model.status })) }))
if (values['check-models']) {
  process.stdout.write(`${json({ status: 'connected', providers: available })}\n`)
  process.exit(0)
}
assert(values.worktree && values['task-file'], 'Pass --worktree and --task-file, or use --check-models.')
const root = await realpath(resolve(values.worktree))
assert((await lstat(join(root, '.git'))).isFile(), 'Acceptance requires a linked worktree, not the primary checkout.')
const git = async (...args: string[]) => (await command('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout
assert.equal(await realpath((await git('rev-parse', '--show-toplevel')).trim()), root)
const worktrees = await git('worktree', 'list', '--porcelain')
const registeredRoots = await Promise.all(worktrees.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => realpath(line.slice('worktree '.length))))
assert(registeredRoots.includes(root), 'The supplied directory must be registered as a Git worktree.')
const selected = access.managedModels.find((entry) => entry.providerId === providerId && entry.enabled)
const modelId = selected?.models.find((model) => (model.id === values.model || model.id === `${providerId}/${values.model}`) && model.status === 'available')?.id
assert(modelId, 'Selected model is not available to the signed-in account.')
let task = await readFile(resolve(values['task-file']), 'utf8')
assert(task.trim(), 'The natural task must not be empty.')
const timeoutMs = Number(values['timeout-ms'])
const maximumRequests = Number(values['max-model-requests'])
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 7_200_000)
assert(Number.isSafeInteger(maximumRequests) && maximumRequests > 0 && maximumRequests <= 200)

const requestedParent = resolve(values['output-parent'] ?? tmpdir())
await mkdir(requestedParent, { recursive: true })
const parent = await realpath(requestedParent)
const relativeOutput = relative(root, parent)
assert(relativeOutput === '..' || relativeOutput.startsWith('../') || relativeOutput.startsWith('..\\') || isAbsolute(relativeOutput), 'Keep acceptance output outside the tested worktree.')
const output = await mkdtemp(join(parent, 'project-surface-natural-'))
const recoverySeed = values['recovery-seed'] ? await ProjectRecoverySeed.prepare(root, output, resolve(values['recovery-seed'])) : undefined
if (recoverySeed) task += `\n本轮受控恢复目标文件：${recoverySeed.fixturePath}。只处理此文件，保持其余现有工作原样。`
await writeFile(join(output, 'task.txt'), task)
await writeFile(join(output, 'baseline.patch'), await git('diff', '--binary', 'HEAD'))
await writeFile(join(output, 'baseline-status.txt'), await git('status', '--porcelain=v1'))
await writeFile(join(output, 'metadata.json'), json({
  kind: recoverySeed ? 'fault-injection-with-real-model-recovery' : 'production-model-acceptance', fixture: values['fixture-label'] ?? null,
  projectRoot: root, provider: providerId, model: modelId,
  baseRevision: (await git('rev-parse', 'HEAD')).trim(), timeoutMs, maximumRequests,
  taskInput: 'Task file is sent as written; the harness does not recommend tool names.',
}))

const [{ WorkbenchAgentExecutionStack }, { WorkbenchContextPayloadStore }, { ProjectCapabilityProvider }] = await Promise.all([
  import('../../src/main/agent/WorkbenchAgentExecutionStack'),
  import('../../src/main/agent/WorkbenchContextRecall'),
  import('../../src/main/workspace/ProjectCapabilityProvider'),
])
const composition = createModelRuntimeComposition()
const requests: Array<{ index: number; startedAt: string; bodyChars: number; status?: number; source?: string }> = []
const toolCalls: Array<{ name: string; id: string; inputChars: number }> = []
const toolResults: unknown[] = []
const usageEvents: unknown[] = []
let writing = Promise.resolve()
const record = (kind: string, value: unknown) => {
  const line = `${JSON.stringify(sanitize({ at: new Date().toISOString(), kind, value }))}\n`
  writing = writing.then(() => appendFile(join(output, 'events.jsonl'), line))
}
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error('Acceptance time limit reached.')), timeoutMs)
composition.velarCloudRuntime.registerProvider(providerId, {
  baseURL: account.getManagedModelBaseUrl(providerId),
  fetch: async (input, init) => {
    if (requests.length >= maximumRequests) {
      controller.abort(new Error('Acceptance request limit reached.'))
      throw controller.signal.reason
    }
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : ''
    const entry = { index: requests.length + 1, startedAt: new Date().toISOString(), bodyChars: body.length, status: undefined as number | undefined, source: 'real-provider' }
    requests.push(entry)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { parsed = { body } }
    await writeFile(join(output, `model-request-${String(entry.index).padStart(3, '0')}.json`), json(parsed))
    const injected = recoverySeed ? await recoverySeed.intercept(parsed as Record<string, unknown>) : undefined
    if (injected) {
      entry.source = 'injected-model-tool-call'
      entry.status = injected.status
      record('injected-model-response', { index: entry.index, status: entry.status })
      return injected
    }
    const response = await account.fetchManagedModel(providerId, input, init)
    entry.status = response.status
    record('provider-response', { index: entry.index, status: response.status })
    return response
  },
})
const provider = new ProjectCapabilityProvider()
const store = new WorkbenchContextPayloadStore(() => join(output, 'context-payloads'))
const stack = new WorkbenchAgentExecutionStack(provider, composition, undefined, async (id) => {
  const entry = access.managedModels.find((item) => item.providerId === id && item.enabled)
  return entry ? entry.models.filter((model) => model.status === 'available').map(({ id, label }) => ({ id, label })) : null
}, undefined, undefined, undefined, undefined, store)
const started = performance.now()
let result: unknown
let recovery: Record<string, unknown> | undefined
let error: string | undefined
try {
  result = await stack.run({
    sessionId: `natural-${Date.now()}`, executionId: `acceptance-${Date.now()}`,
    projectRoot: root, messages: [{ role: 'user', content: task }],
    config: { modelSelection: { provider: providerId, model: modelId }, permissionConfirmationMode: 'never-ask' },
    abortSignal: controller.signal,
    rendererAttached: false,
    events: new ExecutionEventBus({
      agent: (event) => {
        record('agent', event)
        recoverySeed?.record(event)
        if (event.type === 'tool-start') toolCalls.push({ name: event.toolName, id: event.toolCallId, inputChars: JSON.stringify(event.args ?? {}).length })
        if (event.type === 'tool-done') toolResults.push(sanitize(event))
        if (event.type === 'runtime' && event.payload.kind === 'usage-telemetry') usageEvents.push(sanitize(event))
      },
      state: (value) => record('state', value),
      debug: (value) => record('debug', value),
    }),
  })
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught)
} finally {
  clearTimeout(timeout)
  await stack.dispose()
  await provider.dispose()
  await writing
  if (recoverySeed) {
    try { recovery = await recoverySeed.finish() }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  }
  const changed = await git('status', '--porcelain=v1')
  await writeFile(join(output, 'final-status.txt'), changed)
  await writeFile(join(output, 'changes.patch'), await git('diff', '--binary', 'HEAD'))
  await writeFile(join(output, 'untracked-paths.txt'), await git('ls-files', '--others', '--exclude-standard'))
  await writeFile(join(output, 'tool-results.json'), json(toolResults))
  await writeFile(join(output, 'usage-events.json'), json(usageEvents))
  await writeFile(join(output, 'summary.json'), json({ result, error, recovery, elapsedMs: Math.round(performance.now() - started), requests, toolCalls, changed }))
  process.stdout.write(`${json({ output, result, error, recovery, requestCount: requests.length, toolCallCount: toolCalls.length, elapsedMs: Math.round(performance.now() - started) })}\n`)
}
if (error || recovery?.passed === false || (result as { status?: string } | undefined)?.status !== 'completed') process.exitCode = 1
