import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { test } from 'bun:test'

import {
  bindWorkbenchConversationExecution,
  readWorkbenchConversationExecution,
  WorkbenchConversationBindingFileName,
  WorkbenchConversationContextFileName,
} from '../src/main/conversation/WorkbenchConversationBinding'
import { WorkbenchConversationStore } from '../src/main/conversation/WorkbenchConversationStore'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-conversation-binding-'))
  const workspace = join(directory, 'project')
  await mkdir(workspace)
  const projectRoot = await realpath(workspace)
  const dataDir = join(directory, 'session')
  return {
    directory,
    dataDir,
    options: {
      dataDir,
      projectRoot,
      sessionId: 'chat-a',
      sandbox: false,
      binding: { executionIdentity: 'local-node-a', authorizationScope: 'project-policy-v1' },
    },
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

test('the same execution receipt reopens without replacing its bytes', async () => {
  const f = await fixture()
  try {
    await assert.rejects(readWorkbenchConversationExecution(f.options), { code: 'NOT_FOUND' })
    const receipt = await bindWorkbenchConversationExecution(f.options)
    const path = join(f.dataDir, WorkbenchConversationBindingFileName)
    const saved = await readFile(path)
    assert.deepEqual(receipt, {
      version: 1,
      projectRoot: f.options.projectRoot,
      sessionId: f.options.sessionId,
      sandbox: f.options.sandbox,
      binding: f.options.binding,
    })
    assert.deepEqual(await readWorkbenchConversationExecution(f.options), receipt)
    assert.deepEqual(
      await bindWorkbenchConversationExecution({ ...f.options, binding: { ...f.options.binding } }),
      receipt
    )
    assert.deepEqual(await readFile(path), saved)
  } finally {
    await f.close()
  }
})

test('changed scope, sandbox or ownership conflicts preserve the original receipt', async () => {
  const f = await fixture()
  try {
    await bindWorkbenchConversationExecution(f.options)
    const path = join(f.dataDir, WorkbenchConversationBindingFileName)
    const saved = await readFile(path)
    const other = join(f.directory, 'other-project')
    await mkdir(other)
    for (const change of [
      { binding: { ...f.options.binding, authorizationScope: 'project-policy-v2' } },
      { binding: { ...f.options.binding, executionIdentity: 'local-node-b' } },
      { sandbox: true },
      { projectRoot: other },
      { sessionId: 'chat-b' },
    ])
      await assert.rejects(bindWorkbenchConversationExecution({ ...f.options, ...change }), {
        code: 'CONFLICT',
      })
    await assert.rejects(
      readWorkbenchConversationExecution({ ...f.options, sessionId: 'chat-b' }),
      { code: 'CONFLICT' }
    )
    assert.deepEqual(await readFile(path), saved)
  } finally {
    await f.close()
  }
})

test('damaged receipts reject reads and binding without resetting the file', async () => {
  const f = await fixture()
  try {
    await bindWorkbenchConversationExecution(f.options)
    const path = join(f.dataDir, WorkbenchConversationBindingFileName)
    const damaged = '{"version":1'
    await writeFile(path, damaged)
    await assert.rejects(readWorkbenchConversationExecution(f.options), { code: 'CONFLICT' })
    await assert.rejects(bindWorkbenchConversationExecution(f.options), { code: 'CONFLICT' })
    assert.equal(await readFile(path, 'utf8'), damaged)
  } finally {
    await f.close()
  }
})

test('existing context without a product receipt is unknown storage and cannot be rebound', async () => {
  const f = await fixture()
  try {
    await mkdir(f.dataDir)
    const path = join(f.dataDir, WorkbenchConversationContextFileName)
    await writeFile(path, 'existing context storage')
    await assert.rejects(readWorkbenchConversationExecution(f.options), { code: 'CONFLICT' })
    await assert.rejects(bindWorkbenchConversationExecution(f.options), { code: 'CONFLICT' })
    assert.equal(await readFile(path, 'utf8'), 'existing context storage')
    await assert.rejects(stat(join(f.dataDir, WorkbenchConversationBindingFileName)), {
      code: 'ENOENT',
    })
  } finally {
    await f.close()
  }
})

test('the new storage generation ignores and preserves the legacy session directory', async () => {
  const f = await fixture()
  try {
    const store = new WorkbenchConversationStore(join(f.directory, 'state'))
    const path = store.path(f.options.projectRoot, f.options.sessionId)
    const legacy = join(f.directory, 'state', basename(path))
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'history'), 'legacy history')
    assert.equal(await store.exists(f.options.projectRoot, f.options.sessionId), false)

    await mkdir(path, { recursive: true })
    assert.equal(await store.exists(f.options.projectRoot, f.options.sessionId), true)
    await store.delete(f.options.projectRoot, f.options.sessionId)
    assert.equal(await store.exists(f.options.projectRoot, f.options.sessionId), false)
    assert.equal(await readFile(join(legacy, 'history'), 'utf8'), 'legacy history')
  } finally {
    await f.close()
  }
})
