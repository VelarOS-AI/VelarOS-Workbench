import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  ContextGovernanceSessionRegistry,
  type ContextPayloadRecord,
  createContextPayloadRef,
} from '@velaros-ai/agent'

import {
  createWorkbenchContextRecall,
  WorkbenchContextPayloadStore,
} from '../src/main/agent/WorkbenchContextRecall'

function payload(id: string, text = `value:${id}`, sessionId = 'session'): ContextPayloadRecord {
  return {
    sessionId,
    hash: id,
    payloadRef: createContextPayloadRef(sessionId, id),
    toolCallId: `input:${id}`,
    toolName: 'project:edit',
    serializedResult: text,
    chars: text.length,
    createdAt: 1,
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-context-persistence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, open: () => new WorkbenchContextPayloadStore(() => directory) }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function blobPath(directory: string, record: ContextPayloadRecord) {
  return join(directory, 'sessions', digest(record.sessionId), `${digest(record.hash)}.json`)
}

function referencePath(directory: string, key: string, sessionId?: string) {
  const references = join(directory, 'references')
  return join(
    sessionId === undefined ? references : join(references, digest(sessionId)),
    `${digest(key)}.json`,
  )
}

void test('reopened recall service restores original edit arguments and JSON path without changing encoding', async (t) => {
  const { open } = await fixture(t)
  const edits = [{ path: '中文/😀.ts', content: '第一行\r\n\\n\\\\$`\t😀\u0000\u2028结束' }]
  const record = payload('large-edit', JSON.stringify({ edits }))
  await open().put(record)
  const restarted = open()
  assert.deepEqual(await restarted.findByHash('session', record.hash), record)
  assert.equal(
    (await restarted.loadToolPayload('session', record.payloadRef))?.serializedResult,
    record.serializedResult,
  )
  assert.equal(
    (await restarted.loadToolPayload('session', `tool:${record.toolCallId}`))?.serializedResult,
    record.serializedResult,
  )
  assert.deepEqual(await restarted.listForSession('session'), [record])
  assert.equal(Object.keys((await restarted.loadSessionPayloads('session')).toolResults).length, 1)
  const recall = createWorkbenchContextRecall(new ContextGovernanceSessionRegistry(), restarted)
  const result = await recall
    .conversationFor({ sessionId: 'session', executionId: 'after-restart' })
    .retrieveContextPayload({
      sessionId: 'session',
      handleId: record.toolCallId,
      jsonPath: '$.edits',
      maxChars: 30000,
    })
  assert.equal(result.found, true)
  assert.ok(result.content)
  const body = result.content.split('serializedResultAtPath:\n')[1]
  assert.deepEqual(JSON.parse(body), edits)
})

void test('401 concurrent writes outlive count eviction; reads and delete are ordered', async (t) => {
  const { open } = await fixture(t)
  const store = open()
  const records = Array.from({ length: 401 }, (_, i) => payload(`batch-${i}`, `边界😀${i}`))
  await Promise.all(records.map((record) => store.put(record)))
  assert.deepEqual(await store.findByHash('session', records[0].hash), records[0])
  assert.equal((await open().listForSession('session')).length, 401)
  const found = await open().findManyByHash('session', [
    'batch-0',
    'batch-400',
    'missing',
    'batch-0',
  ])
  assert.equal(found.size, 2)
  const removal = store.deleteSession('session')
  const afterRemoval = store.findByHash('session', records[0].hash)
  await removal
  assert.equal(await afterRemoval, null)
  assert.equal(await open().loadToolPayload('session', records[0].toolCallId), null)
})

void test('payload larger than the 32 MiB character cache remains exactly recallable', async (t) => {
  const { open } = await fixture(t)
  const store = open()
  const record = payload('oversized', '中文😀\\\r\n'.repeat(4_800_000))
  assert.ok(record.chars > 32 * 1024 * 1024)
  await store.put(record)
  assert.equal(
    (await store.findByHash('session', record.hash))?.serializedResult,
    record.serializedResult,
  )
  assert.equal(
    (await open().loadToolPayload('session', record.toolCallId))?.serializedResult,
    record.serializedResult,
  )
})

void test('idempotent writes preserve canonical identity and repair missing references', async (t) => {
  const { directory, open } = await fixture(t)
  const store = open()
  const record = payload('same')
  await store.put(record)
  await rm(join(directory, 'references'), { recursive: true })
  assert.deepEqual(await store.put({ ...record, createdAt: 2, toolCallId: 'second-call' }), record)
  assert.deepEqual(await open().findByHash('session', record.hash), record)
  assert.equal(
    (await open().loadToolPayload('session', record.toolCallId))?.serializedResult,
    record.serializedResult,
  )
  await assert.rejects(
    store.put({ ...record, serializedResult: 'different' }),
    /cannot be overwritten/,
  )
  assert.deepEqual(await store.findByHash('session', record.hash), record)
})

void test('failed writes are not cached and do not poison subsequent writes', async (t) => {
  const { directory, open } = await fixture(t)
  const store = open()
  await writeFile(join(directory, 'sessions'), 'not a directory')
  const record = payload('disk-failure')
  await assert.rejects(store.put(record))
  await rm(join(directory, 'sessions'))
  assert.equal(await store.findByHash('session', record.hash), null)
  await store.put(record)
  assert.deepEqual(await open().findByHash('session', record.hash), record)
})

void test('checksum corruption is reported and a broken reference cannot return another payload', async (t) => {
  const { directory, open } = await fixture(t)
  const record = payload('corruption')
  await open().put(record)
  const path = blobPath(directory, record)
  const original = await readFile(path, 'utf8')
  const envelope = JSON.parse(original)
  envelope.record.serializedResult = 'tampered'
  await writeFile(path, JSON.stringify(envelope))
  await assert.rejects(open().findByHash('session', record.hash), /integrity/)
  await assert.rejects(open().listForSession('session'), /integrity/)
  await writeFile(path, original)
  const other = payload('other')
  await open().put(other)
  await writeFile(
    join(directory, 'references', digest(record.sessionId), `${digest(record.toolCallId)}.json`),
    JSON.stringify({ sessionId: other.sessionId, hash: other.hash }),
  )
  await assert.rejects(open().loadToolPayload('session', record.toolCallId), /does not match/)
})

void test('opaque paths stay inside storage; deleting one session preserves the other across restart', async (t) => {
  const { directory, open } = await fixture(t)
  const record = payload('../outside\u0000😀', 'source', '../../session/😀')
  const other = payload('other', 'kept', 'other-session')
  const store = open()
  await store.putMany([record, other])
  assert.equal((await stat(blobPath(directory, record))).mode & 0o777, 0o600)
  assert.ok(
    (await readdir(join(directory, 'sessions'))).every((name) => /^[a-f0-9]{64}$/u.test(name)),
  )
  const returned = await store.findByHash(record.sessionId, record.hash)
  assert.ok(returned)
  returned.serializedResult = 'mutated'
  assert.equal((await store.findByHash(record.sessionId, record.hash))?.serializedResult, 'source')
  await store.deleteSession(record.sessionId)
  assert.deepEqual(await open().listForSession(record.sessionId), [])
  assert.equal(await open().loadToolPayload('parent', record.payloadRef), null)
  assert.deepEqual(await open().findByHash(other.sessionId, other.hash), other)
})

void test('deleting a session tolerates corrupt references without harming other sessions', async (t) => {
  const { directory, open } = await fixture(t)
  const target = payload('target-corrupt-reference', 'delete me', 'target-session')
  const other = payload('other-preserved', 'keep 中文😀\\\r\n', 'other-session')
  const unrelatedCorruptReference = referencePath(directory, 'unrelated-corrupt-reference')
  const store = open()
  await store.putMany([target, other])

  await writeFile(referencePath(directory, target.toolCallId, target.sessionId), '{broken target')
  await writeFile(referencePath(directory, target.toolCallId), '{broken target')
  await writeFile(unrelatedCorruptReference, '{broken unrelated')

  await store.deleteSession(target.sessionId)
  await store.deleteSession(target.sessionId)

  const restarted = open()
  assert.deepEqual(await restarted.listForSession(target.sessionId), [])
  assert.equal(await restarted.findByHash(target.sessionId, target.hash), null)
  assert.equal(await restarted.loadToolPayload(target.sessionId, target.toolCallId), null)
  assert.deepEqual(await restarted.findByHash(other.sessionId, other.hash), other)
  assert.equal(
    (await restarted.loadToolPayload(other.sessionId, other.toolCallId))?.serializedResult,
    other.serializedResult,
  )
  assert.equal(
    (await restarted.loadToolPayload('parent-session', other.payloadRef))?.serializedResult,
    other.serializedResult,
  )
  assert.equal(await readFile(unrelatedCorruptReference, 'utf8'), '{broken unrelated')
})

void test('deleting a session removes every attributable malformed reference address', async (t) => {
  const malformedReferences = [
    ['invalid JSON', '{broken'],
    ['null', 'null'],
    ['empty object', '{}'],
    ['array', '[]'],
    ['string', '"not an address"'],
  ] as const

  for (const [label, serializedReference] of malformedReferences) {
    const { directory, open } = await fixture(t)
    const target = payload(`malformed-${label}`, 'delete me', `target-${label}`)
    const other = payload(`preserved-${label}`, `keep ${label}`, `other-${label}`)
    const targetGlobalReference = referencePath(directory, target.toolCallId)
    const targetScopedReference = referencePath(directory, target.toolCallId, target.sessionId)
    const otherGlobalReference = referencePath(directory, other.toolCallId)
    const otherAddress = { sessionId: other.sessionId, hash: other.hash }
    const store = open()
    await store.putMany([target, other])
    await writeFile(targetScopedReference, serializedReference)
    await writeFile(targetGlobalReference, serializedReference)

    await store.deleteSession(target.sessionId)

    await assert.rejects(readFile(targetGlobalReference, 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(targetScopedReference, 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(await readFile(otherGlobalReference, 'utf8')), otherAddress)
    const restarted = open()
    assert.equal(await restarted.loadToolPayload(target.sessionId, target.toolCallId), null)
    assert.deepEqual(await restarted.findByHash(other.sessionId, other.hash), other)
    assert.equal(
      (await restarted.loadToolPayload(other.sessionId, other.toolCallId))?.serializedResult,
      other.serializedResult,
    )
  }
})

void test('failed global cleanup retains scoped ownership evidence for a successful retry', async (t) => {
  const { directory, open } = await fixture(t)
  const target = payload('retry-target', 'delete me', 'retry-target-session')
  const other = payload('retry-other', 'keep me', 'retry-other-session')
  const targetGlobalReference = referencePath(directory, target.toolCallId)
  const targetScopedReference = referencePath(directory, target.toolCallId, target.sessionId)
  const otherGlobalReference = referencePath(directory, other.toolCallId)
  const otherAddress = { sessionId: other.sessionId, hash: other.hash }
  const store = open()
  await store.putMany([target, other])
  await writeFile(targetScopedReference, 'null')
  await rm(targetGlobalReference)
  await mkdir(targetGlobalReference)

  await assert.rejects(
    store.deleteSession(target.sessionId),
    (error: NodeJS.ErrnoException) => error.code === 'EISDIR',
  )
  assert.equal(await readFile(targetScopedReference, 'utf8'), 'null')
  assert.deepEqual(JSON.parse(await readFile(otherGlobalReference, 'utf8')), otherAddress)
  assert.deepEqual(await open().findByHash(other.sessionId, other.hash), other)

  await rm(targetGlobalReference, { recursive: true })
  await writeFile(targetGlobalReference, 'null')
  await store.deleteSession(target.sessionId)
  await store.deleteSession(target.sessionId)

  await assert.rejects(readFile(targetGlobalReference, 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(targetScopedReference, 'utf8'), { code: 'ENOENT' })
  const restarted = open()
  assert.equal(await restarted.loadToolPayload(target.sessionId, target.toolCallId), null)
  assert.deepEqual(await restarted.findByHash(other.sessionId, other.hash), other)
  assert.deepEqual(JSON.parse(await readFile(otherGlobalReference, 'utf8')), otherAddress)
  assert.equal(
    (await restarted.loadToolPayload(other.sessionId, other.toolCallId))?.serializedResult,
    other.serializedResult,
  )
})

void test('unfinished atomic temporary files do not enter the session list', async (t) => {
  const { directory, open } = await fixture(t)
  const record = payload('completed')
  await open().put(record)
  const sessionDirectory = join(directory, 'sessions', digest(record.sessionId))
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(join(sessionDirectory, 'interrupted.tmp'), '{')
  assert.deepEqual(await open().listForSession(record.sessionId), [record])
})

void test('acknowledged payload survives writer process exit and a new reader process', async (t) => {
  const { directory } = await fixture(t)
  const record = payload(
    'process-restart',
    JSON.stringify({ edits: [{ content: '真实😀\r\n\\n'.repeat(1200) }] }),
  )
  const moduleUrl = pathToFileURL(resolve('src/main/agent/WorkbenchContextRecall.ts')).href
  const prelude = `import { WorkbenchContextPayloadStore } from ${JSON.stringify(moduleUrl)}; const store = new WorkbenchContextPayloadStore(() => ${JSON.stringify(directory)});`
  const run = promisify(execFile)
  await run(process.execPath, ['--eval', `${prelude} await store.put(${JSON.stringify(record)});`])
  const { stdout } = await run(process.execPath, [
    '--eval',
    `${prelude} console.log(JSON.stringify(await store.loadToolPayload('session', ${JSON.stringify(record.toolCallId)})));`,
  ])
  assert.equal(JSON.parse(stdout).serializedResult, record.serializedResult)
})

void test('duplicate tool call ids stay session-scoped while full payload refs cross sessions', async (t) => {
  const { directory, open } = await fixture(t)
  const first = payload('first', 'first original', 'first-session')
  const second = {
    ...payload('second', 'second original', 'second-session'),
    toolCallId: first.toolCallId,
  }
  const globalReference = referencePath(directory, first.toolCallId)
  const secondAddress = { sessionId: second.sessionId, hash: second.hash }
  await open().putMany([first, second])
  assert.deepEqual(JSON.parse(await readFile(globalReference, 'utf8')), secondAddress)

  // A legacy installation may only have the global index; it remains valid for its own session.
  await rm(referencePath(directory, second.toolCallId, second.sessionId))
  assert.equal(
    (await open().loadToolPayload(second.sessionId, second.toolCallId))?.serializedResult,
    second.serializedResult,
  )

  await open().deleteSession(first.sessionId)

  const restarted = open()
  assert.deepEqual(JSON.parse(await readFile(globalReference, 'utf8')), secondAddress)
  assert.equal(await restarted.loadToolPayload(first.sessionId, first.toolCallId), null)
  assert.equal(await restarted.loadToolPayload('unrelated-session', first.toolCallId), null)
  assert.equal(
    (await restarted.loadToolPayload(second.sessionId, second.toolCallId))?.serializedResult,
    second.serializedResult,
  )
  assert.equal(
    (await restarted.loadToolPayload('unrelated-session', second.payloadRef))?.serializedResult,
    second.serializedResult,
  )
})
