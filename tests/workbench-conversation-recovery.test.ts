import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { WorkbenchConversationRecovery } from '../src/main/conversation/WorkbenchConversationRecovery'
import {
  forgetStandaloneChatSession,
  readStandaloneChatSessionOwner,
  registerStandaloneChatSession,
} from '../src/renderer/src/runtime/standaloneChatSessionRegistry'
import {
  applyStandaloneConversationState,
  type StandaloneConversationRuntime,
} from '../src/renderer/src/runtime/standaloneWorkbenchChatRuntime'
import {
  type StandaloneConversationStreamRun,
  StandaloneWorkbenchConversationRecovery,
} from '../src/renderer/src/runtime/standaloneWorkbenchConversationRecovery'
import type { WorkbenchConversationBridge } from '../src/shared/workbenchConversation'

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
    expect(page?.events.every((envelope) => envelope.inputId === run.inputId)).toBe(true)
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
    const filePath = join(directory, file!)
    const legacy = (await readFile(filePath, 'utf8')).replace(/"inputId":"a",(?="projectRoot")/u, '')
    await writeFile(filePath, legacy)
    await appendFile(filePath, '{"envelope":')
    const recovered = await new WorkbenchConversationRecovery(directory).read(ref, {}, false)
    expect(recovered?.events).toHaveLength(1)
    expect(recovered?.events[0]).toMatchObject({ inputId: 'a', streamId: run.id })
    const conflicting = legacy.replace(/"streamId":/u, '"inputId":"forged","streamId":')
    await writeFile(filePath, conflicting)
    await expect(new WorkbenchConversationRecovery(directory).read(ref, {}, false)).rejects.toThrow(
      '会话事件身份与运行记录不符'
    )
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

test('a revoked slow recovery cannot replace its successor run or consume its stream cursor', async () => {
  const projectRoot = 'renderer-recovery-owner'
  const sessionId = 'renderer-recovery-session'
  registerStandaloneChatSession(sessionId, projectRoot)
  const originalSession = readStandaloneChatSessionOwner(projectRoot, sessionId)!
  registerStandaloneChatSession(sessionId, projectRoot)
  expect(readStandaloneChatSessionOwner(projectRoot, sessionId)).toBe(originalSession)
  let releaseRead!: (result: Awaited<ReturnType<WorkbenchConversationBridge['recover']>>) => void
  const slowRead = new Promise<Awaited<ReturnType<WorkbenchConversationBridge['recover']>>>(
    (resolve) => {
      releaseRead = resolve
    }
  )
  let reads = 0
  let restoredRuns = 0
  let current: StandaloneConversationStreamRun | null = null
  let state: StandaloneConversationRuntime = {
    status: 'running',
    teamPhase: null,
    activeTurn: null,
    completedTurns: 0,
    lastError: null,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    connectionRetryMessage: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationId: null,
    awaitingConfirmationExecutionId: null,
    lastRunFinishedAt: null,
  }
  const errors: unknown[] = []
  const recovery = new StandaloneWorkbenchConversationRecovery<StandaloneConversationStreamRun>({
    recover: async () => {
      reads += 1
      return reads === 1 ? slowRead : { ok: true, value: null }
    },
    readSessions: () => [{ sessionId }],
    readRun: () => current,
    createRun: (run, sessionOwner) => {
      restoredRuns += 1
      current = { ...run, sessionOwner, streamId: run.id, lastSequence: 0 }
      return current
    },
    apply: (_run, envelope) => {
      if (envelope.event.type === 'state')
        state = applyStandaloneConversationState(state, envelope.event.payload)
    },
    onError: (error) => {
      errors.push(error)
    },
  })
  const originalProject = recovery.mountProject(projectRoot)
  try {
    const pendingRecovery = recovery.ensureProject(projectRoot)
    expect(recovery.ensureProject(projectRoot)).toBe(pendingRecovery)
    const originalClaim = recovery.claimSubmission(projectRoot, sessionId)
    await Promise.resolve()
    expect(reads).toBe(1)
    forgetStandaloneChatSession(sessionId)
    expect(originalClaim.signal.aborted).toBe(true)
    registerStandaloneChatSession(sessionId, projectRoot)
    const successorProject = recovery.mountProject(projectRoot)
    const successorClaim = recovery.claimSubmission(projectRoot, sessionId)
    recovery.releaseProject(originalProject)
    await recovery.ensureProject(projectRoot)
    recovery.releaseSubmission(originalClaim)
    recovery.assertSubmission(successorClaim)
    const successor = {
      projectRoot,
      sessionId,
      inputId: 'new-input',
      sessionOwner: successorClaim.session,
      streamId: 'new-stream',
      lastSequence: 0,
    }
    current = successor
    releaseRead({
      ok: true,
      value: {
        run: {
          projectRoot,
          sessionId,
          inputId: 'old-input',
          id: 'old-stream',
          goalMode: false,
          startedAt: 1,
        },
        events: [],
        active: false,
        nextAfter: 0,
        hasMore: false,
      },
    })
    await expect(pendingRecovery).rejects.toThrow('项目会话已离开')
    expect(restoredRuns).toBe(0)
    expect(current).toBe(successor)
    recovery.assertSubmission(successorClaim)
    recovery.receive({
      projectRoot,
      sessionId,
      inputId: 'old-input',
      streamId: 'old-stream',
      sequence: 99,
      event: { type: 'state', payload: { kind: 'done' } },
    })
    recovery.receive({
      projectRoot,
      sessionId,
      inputId: 'new-input',
      streamId: 'old-stream',
      sequence: 100,
      event: { type: 'state', payload: { kind: 'done' } },
    })
    expect(state.status).toBe('running')
    expect(successor.lastSequence).toBe(0)
    expect(reads).toBe(2)
    // 已接纳的 native run 仍属于原项目快照，UI离开不丢弃它的真实终态。
    recovery.releaseSubmission(successorClaim)
    recovery.releaseProject(successorProject)
    recovery.receive({
      projectRoot,
      sessionId,
      inputId: 'new-input',
      streamId: 'new-stream',
      sequence: 1,
      event: { type: 'state', payload: { kind: 'done' } },
    })
    expect(state.status).toBe('completed')
    expect(successor.lastSequence).toBe(1)
    expect(errors).toEqual([])
  } finally {
    recovery.disposePreparations()
    forgetStandaloneChatSession(sessionId)
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
