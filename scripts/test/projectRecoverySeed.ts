import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

type Data = Record<string, any>
const command = promisify(execFile)
const SeedReadId = 'call_acceptance_seed_read'
const SeedEditId = 'call_acceptance_seed_edit'

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => part?.text ?? '').join('')
  return ''
}
function resultFor(request: Data, callId: string): Data {
  const message = request.messages?.find((item: Data) => item.role === 'tool' && item.tool_call_id === callId)
  assert(message, `Missing production receipt for ${callId}`)
  return JSON.parse(textContent(message.content))
}
function findFileRef(value: unknown, path: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) return value.map((item) => findFileRef(item, path)).find(Boolean)
  const item = value as Data
  if ((item.path === path || item.snapshot?.path === path) && typeof item.fileRef === 'string') return item.fileRef
  return Object.values(item).map((nested) => findFileRef(nested, path)).find(Boolean)
}
function response(request: Data, toolName: string, callId: string, input: Data): Response {
  const advertised = request.tools?.map((tool: Data) => tool.function ?? tool).find((tool: Data) => tool.name === toolName || tool.name === toolName.replaceAll(':', '__'))
  assert(advertised, `Seed tool is not advertised: ${toolName}`)
  const chunk = (delta: Data, finishReason: string | null) => JSON.stringify({
    id: `fixture-${callId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  const content = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: advertised.name, arguments: JSON.stringify(input) } }] }, null)
  return new Response(`data: ${content}\n\ndata: ${chunk({}, 'tool_calls')}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
async function worktreeState(root: string): Promise<Data> {
  const run = async (...args: string[]) => (await command('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout
  const paths = (await run('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
  const untracked = await Promise.all(paths.map(async (path) => ({ path, hash: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })))
  return { diff: await run('diff', '--binary', 'HEAD'), status: await run('status', '--porcelain=v1'), untracked }
}

/** Only model responses are seeded. Reads, references, validation, persistence, and receipts use production code. */
export class ProjectRecoverySeed {
  private requestIndex = 0
  private injectedResponses = 0
  private realRequests = 0
  private failedInput: Data | undefined
  private validatedFailure = false
  private readonly starts = new Map<string, Data>()
  private readonly done = new Map<string, Data>()
  private constructor(
    private readonly root: string,
    private readonly output: string,
    readonly fixturePath: string,
    private readonly source: string,
    private readonly expected: string,
    private readonly template: Data,
    private readonly baseline: Data,
  ) {}

  static async prepare(root: string, output: string, specPath: string): Promise<ProjectRecoverySeed> {
    const spec = JSON.parse(await readFile(specPath, 'utf8')) as Data
    assert.equal(typeof spec.sourceContent, 'string')
    assert.equal(typeof spec.expectedContent, 'string')
    assert.equal(typeof spec.sourcePath, 'string')
    assert.equal(spec.failedInput?.files?.length, 1)
    assert.deepEqual(spec.failedInput.files[0].edits[2].range, [48, 88])
    const parent = resolve(root, dirname(spec.sourcePath))
    const rel = relative(root, parent)
    assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'Fixture must be inside the worktree')
    const fixturePath = join(rel, `.acceptance-project-recovery-${randomUUID()}.ts`)
    const baseline = await worktreeState(root)
    await writeFile(join(root, fixturePath), spec.sourceContent, { flag: 'wx' })
    await writeFile(join(output, 'seed-source.ts'), spec.sourceContent)
    await writeFile(join(output, 'seed-expected.ts'), spec.expectedContent)
    await writeFile(join(output, 'seed-spec.json'), JSON.stringify({ kind: 'fault-injection', fixturePath, failedInput: spec.failedInput, correctedRange: [48, 89] }, null, 2))
    return new ProjectRecoverySeed(root, output, fixturePath, spec.sourceContent, spec.expectedContent, spec.failedInput, baseline)
  }

  record(event: Data): void {
    if (event.type === 'tool-start') this.starts.set(event.toolCallId, structuredClone(event))
    if (event.type === 'tool-done') this.done.set(event.toolCallId, structuredClone(event))
  }

  async intercept(request: Data): Promise<Response | undefined> {
    this.requestIndex += 1
    if (this.requestIndex === 1) {
      const seeded = response(request, 'project:read', SeedReadId, { path: this.fixturePath, maxChars: 24000 })
      this.injectedResponses += 1
      return seeded
    }
    if (this.requestIndex === 2) {
      let fileRef = findFileRef(resultFor(request, SeedReadId), this.fixturePath)
      for (const message of request.messages ?? []) {
        const content = textContent(message.content)
        if (fileRef || message.role !== 'user' || !content.startsWith('[Current project files]\n')) continue
        const serialized = content.split('\n').find((line) => line.startsWith('{\"files\":'))
        if (serialized) fileRef = findFileRef(JSON.parse(serialized), this.fixturePath)
      }
      assert(fileRef, 'Production read must expose its final fileRef')
      this.failedInput = structuredClone(this.template)
      this.failedInput!.files[0].fileRef = fileRef
      const seeded = response(request, 'project:edit', SeedEditId, this.failedInput!)
      this.injectedResponses += 1
      return seeded
    }
    if (!this.validatedFailure) {
      const receipt = resultFor(request, SeedEditId)
      await writeFile(join(this.output, 'seed-failure-receipt.json'), JSON.stringify(receipt, null, 2))
      assert.equal(receipt.code, 'VALIDATION_FAILED')
      assert.equal(receipt.executionOutcome, 'not-applied')
      assert(JSON.stringify(receipt).includes(`attempt:${SeedEditId}`), 'Failure must expose its trusted reuse reference')
      assert.equal(await readFile(join(this.root, this.fixturePath), 'utf8'), this.source, 'Failed seed must not modify the file')
      this.validatedFailure = true
    }
    this.realRequests += 1
    return undefined
  }

  async finish(): Promise<Data> {
    const fixture = join(this.root, this.fixturePath)
    let finalContent: string | undefined
    let fixtureError: string | undefined
    try {
      assert((await lstat(fixture)).isFile(), 'Fixture was removed or replaced with a non-file')
      finalContent = await readFile(fixture, 'utf8')
      await writeFile(join(this.output, 'seed-final.ts'), finalContent)
    } catch (error) { fixtureError = String(error) }
    finally { await unlink(fixture).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
    const actualState = await worktreeState(this.root)
    const realCalls = [...this.starts.values()].filter((call) => ![SeedReadId, SeedEditId].includes(call.toolCallId))
    const edits = realCalls.filter((call) => call.toolName === 'project:edit')
    const recovered = edits.length === 1 && edits[0].args.reuse === `attempt:${SeedEditId}` && !Object.hasOwn(edits[0].args, 'files')
    let onlyExpectedRangeChanged = false
    if (recovered && this.failedInput) {
      const corrected = structuredClone(this.failedInput)
      try {
        for (const change of edits[0].args.changes ?? []) {
          assert.equal(change.op, 'set')
          assert.deepEqual(change.path.slice(0, 5), ['files', 0, 'edits', 2, 'range'])
          assert(change.path.length === 5 || change.path.length === 6 && change.path[5] === 1)
          if (change.path.length === 5) corrected.files[0].edits[2].range = change.value
          else corrected.files[0].edits[2].range[1] = change.value
        }
        assert.deepEqual(corrected.files[0].edits[2].range, [48, 89])
        onlyExpectedRangeChanged = true
      } catch { onlyExpectedRangeChanged = false }
    }
    const checks = {
      productionFailureValidated: this.validatedFailure,
      usedOnlyExpectedReuseCorrection: recovered && onlyExpectedRangeChanged,
      editSucceeded: edits.length === 1 && this.done.get(edits[0].toolCallId)?.result?.changed === true,
      noHistoryRecall: !realCalls.some((call) => call.toolName === 'context:recall'),
      exactExpectedBytes: finalContent === this.expected,
      existingWorktreeUnchanged: JSON.stringify(this.baseline) === JSON.stringify(actualState),
    }
    const report = { kind: 'fault-injection-with-real-model-recovery', injectedModelResponses: this.injectedResponses, realModelRequests: this.realRequests, fixturePath: this.fixturePath, fixtureError, fixtureRemoved: true, passed: Object.values(checks).every(Boolean), checks, realCalls, realResults: [...this.done.values()].filter((call) => ![SeedReadId, SeedEditId].includes(call.toolCallId)) }
    await writeFile(join(this.output, 'recovery-acceptance.json'), JSON.stringify(report, null, 2))
    return report
  }
}
