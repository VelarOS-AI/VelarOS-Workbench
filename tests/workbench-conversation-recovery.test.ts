import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { WorkbenchConversationRecovery } from '../src/main/conversation/WorkbenchConversationRecovery'

const ref = { projectRoot: 'project-a', sessionId: 'session-a' }
test('durable ordered replay, cursor pagination and restart recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'))
  try {
    const journal = new WorkbenchConversationRecovery(directory)
    const run = await journal.begin(ref, 'input', false)
    const writes = Array.from({ length: 140 }, (_, i) =>
      journal.append(run, { type: 'notice', kind: 'test', payload: i })
    )
    await Promise.all(writes)
    const page = await journal.read(ref, {}, true)
    expect(page?.events.length).toBe(128)
    expect(page?.hasMore).toBe(true)
    expect(page?.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: 128 }, (_, i) => i + 1)
    )
    const next = await journal.read(ref, { streamId: run.id, after: 128 }, true)
    expect(next?.events.length).toBe(12)
    expect(next?.hasMore).toBe(false)
    const restarted = new WorkbenchConversationRecovery(directory)
    const recovered = await restarted.read(ref, { streamId: run.id, after: 140 }, false)
    expect(recovered?.events).toHaveLength(1)
    expect(recovered?.events[0]?.event).toMatchObject({
      type: 'state',
      payload: { kind: 'aborted' },
    })
    expect(
      (await restarted.read(ref, { streamId: run.id, after: 141 }, false))?.events
    ).toHaveLength(0)
    expect(await restarted.read({ ...ref, projectRoot: 'other' }, {}, false)).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('completed events survive reopen; deletion rejects late producers; new generation resets cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'))
  try {
    const journal = new WorkbenchConversationRecovery(directory)
    const run = await journal.begin(ref, 'a', false)
    await journal.append(run, { type: 'state', payload: { kind: 'done' } })
    const restarted = new WorkbenchConversationRecovery(directory)
    expect((await restarted.read(ref, {}, false))?.events).toHaveLength(1)
    const newRun = await journal.begin(ref, 'b', true)
    await expect(
      journal.append(run, { type: 'state', payload: { kind: 'done' } })
    ).rejects.toThrow()
    await journal.append(newRun, { type: 'state', payload: { kind: 'done' } })
    expect((await journal.read(ref, { streamId: run.id, after: 999 }, false))?.events).toHaveLength(
      1
    )
    await journal.remove(ref)
    await expect(
      journal.append(newRun, { type: 'state', payload: { kind: 'done' } })
    ).rejects.toThrow()
    expect(await journal.read(ref, {}, false)).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('ignores a crash-torn uncommitted tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'))
  try {
    const journal = new WorkbenchConversationRecovery(directory)
    const run = await journal.begin(ref, 'a', false)
    await journal.append(run, { type: 'state', payload: { kind: 'done' } })
    const [file] = await readdir(directory)
    await appendFile(join(directory, file!), '{"envelope":')
    expect(
      (await new WorkbenchConversationRecovery(directory).read(ref, {}, false))?.events
    ).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent replay and writes preserve every durable event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'))
  try {
    const journal = new WorkbenchConversationRecovery(directory)
    const run = await journal.begin(ref, 'a', false)
    const operations = []
    for (let i = 0; i < 30; i++) {
      operations.push(
        journal.append(run, {
          type: 'notice',
          kind: 'test',
          payload: 'payload'.repeat(10000),
        })
      )
      operations.push(journal.read(ref, {}, true))
    }
    await Promise.all(operations)
    const page = await new WorkbenchConversationRecovery(directory).read(ref, {}, true)
    expect(page?.events).toHaveLength(30)
    expect(page?.events.at(-1)?.sequence).toBe(30)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed journal write rejects later producers but still permits deletion and a new generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-recovery-'))
  try {
    const journal = new WorkbenchConversationRecovery(directory)
    const run = await journal.begin(ref, 'a', false)
    await rm(directory, { recursive: true, force: true })

    await expect(
      journal.append(run, { type: 'state', payload: { kind: 'done' } })
    ).rejects.toThrow()
    await expect(
      journal.append(run, { type: 'state', payload: { kind: 'done' } })
    ).rejects.toThrow()
    await expect(journal.read(ref, {}, true)).rejects.toThrow()
    await journal.remove(ref)
    await expect(
      journal.append(run, { type: 'state', payload: { kind: 'done' } })
    ).rejects.toThrow()

    const nextRun = await journal.begin(ref, 'b', false)
    await journal.append(nextRun, { type: 'state', payload: { kind: 'done' } })
    const page = await journal.read(ref, {}, false)
    expect(page?.run.id).toBe(nextRun.id)
    expect(page?.events.map((event) => event.sequence)).toEqual([1])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
