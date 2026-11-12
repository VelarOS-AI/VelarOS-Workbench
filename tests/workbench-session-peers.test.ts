import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import type { SessionAnswer } from '@velaros-ai/capabilities/sessions/contracts'
import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchConversationDispatcherApi } from '../src/main/conversation/WorkbenchConversationDispatcher'
import type {
  WorkbenchConversationRef,
  WorkbenchConversationRunOutcome,
} from '../src/main/conversation/WorkbenchConversationRuntime'
import { WorkbenchSessionPeers } from '../src/main/conversation/WorkbenchSessionPeers'
import type { WorkbenchConversationSendRequest } from '../src/shared/workbenchConversation'
import type { WorkbenchPeerMember, WorkbenchPeerTask } from '../src/shared/workbenchSessionPeers'

async function fixture(
  options: {
    assertAdmission?(ref: WorkbenchConversationRef): void
    prepareGuidance?(task: WorkbenchPeerTask, signal: AbortSignal): Promise<void>
    acceptGuidance?(task: WorkbenchPeerTask): void
  } = {}
) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'wb-peers-')))
  const members: WorkbenchPeerMember[] = ['a', 'b', 'c'].map((sessionId) => ({
    sessionId,
    title: sessionId,
  }))
  const running = new Set<string>()
  const settled = new Set<(ref: WorkbenchConversationRef) => void>()
  const outcomes = new Set<(outcome: WorkbenchConversationRunOutcome) => void>()
  const prepared: WorkbenchPeerTask[] = []
  const sent: WorkbenchConversationSendRequest[] = []
  const guidancePreparations: WorkbenchPeerTask[] = []
  const acceptedGuidance: WorkbenchPeerTask[] = []
  const cancelled: WorkbenchPeerTask[] = []
  const guided: Array<WorkbenchConversationRef & { inputId: string; text: string }> = []
  const complete = (
    request: WorkbenchConversationSendRequest,
    status: SessionAnswer['status'] = 'completed'
  ) => {
    running.delete(request.sessionId)
    for (const listener of outcomes)
      listener({
        ...request,
        result: { session: request.sessionId, status, answer: request.text, reason: null },
      })
    for (const listener of settled) listener(request)
  }
  const runtime: Pick<
    WorkbenchConversationDispatcherApi,
    'isRunning' | 'subscribeRunSettled' | 'subscribeRunOutcome' | 'submit' | 'guidance'
  > = {
    isRunning: (ref) => running.has(ref.sessionId),
    subscribeRunSettled: (listener) => {
      settled.add(listener)
      return () => {
        settled.delete(listener)
      }
    },
    subscribeRunOutcome: (listener) => {
      outcomes.add(listener)
      return () => {
        outcomes.delete(listener)
      }
    },
    submit: (sink, request, signal = new AbortController().signal) => {
      const accepted = (async () => {
        assert(!running.has(request.sessionId))
        const prepared = typeof sink === 'function' ? await sink(signal) : undefined
        let started = false
        try {
          signal.throwIfAborted()
          sent.push(request)
          running.add(request.sessionId)
          started = true
        } finally {
          await prepared?.finish({ started, reason: signal.reason })
        }
      })()
      return { accepted, completed: accepted }
    },
    guidance: (ref, input) => {
      if (!running.has(ref.sessionId))
        return Promise.reject(new AppError('CONFLICT', '目标运行已结束。'))
      guided.push({ ...ref, ...input })
      return Promise.resolve()
    },
  }
  const peers = new WorkbenchSessionPeers({
    runtime,
    assertAdmission: (ref) => {
      assert.equal(ref.projectRoot, projectRoot)
      options.assertAdmission?.(ref)
    },
    catalog: () => members,
    prepare: async (task) => {
      prepared.push(task)
      return {
        sink: { notice: () => undefined, state: () => undefined },
        finish: async () => {},
      }
    },
    prepareGuidance: async (task, signal) => {
      guidancePreparations.push(task)
      await options.prepareGuidance?.(task, signal)
    },
    acceptGuidance: (task) => {
      acceptedGuidance.push(task)
      options.acceptGuidance?.(task)
    },
    cancelPreparation: (task) => cancelled.push(task),
  })
  const request = (sessionId: string): WorkbenchConversationSendRequest => ({
    projectRoot,
    sessionId,
    inputId: sessionId,
    text: 'task',
    locale: 'zh-CN',
    model: { provider: 'openrouter', model: 'test', apiKey: '', baseURL: '' },
    executionModes: ['goal'],
    permissionMode: 'ask-every-time',
    reasoningLevel: 'high',
    memory: false,
    webSearchEngine: 'google',
    sandbox: true,
  })
  const ports = {
    a: peers.forSession(request('a')),
    b: peers.forSession(request('b')),
    c: peers.forSession(request('c')),
  }
  return {
    peers,
    ports,
    projectRoot,
    members,
    running,
    settled,
    outcomes,
    prepared,
    sent,
    guidancePreparations,
    acceptedGuidance,
    cancelled,
    guided,
    runtime,
    complete,
    request,
    close: async () => {
      peers.close()
      await rm(projectRoot, { recursive: true, force: true })
    },
  }
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((done) => setTimeout(done, 1))
  }
  assert(predicate(), 'Expected the asynchronous delivery to settle')
}

test('peers reject asks and tells before preparation while retaining directory reads', async () => {
  let retiring = false
  let admissions = 0
  const f = await fixture({
    assertAdmission: () => {
      admissions += 1
      if (retiring) throw new AppError('CANCELLED', 'project is retiring')
    },
  })
  try {
    retiring = true
    const signal = new AbortController().signal
    await assert.rejects(f.ports.a.ask({ to: 'b', task: 'review src' }, signal), { code: 'CANCELLED' })
    await assert.rejects(f.ports.a.tell({ to: 'b', message: 'new guidance' }, signal), { code: 'CANCELLED' })
    assert.equal(admissions, 2)
    assert.equal(f.prepared.length, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.guidancePreparations.length, 0)
    assert.equal((await f.ports.a.list()).length, 3)
    assert.equal(admissions, 2)
  } finally {
    await f.close()
  }
})

test('peers use the project catalog, inherit execution settings and return only their own input outcome', async () => {
  const f = await fixture()
  try {
    assert.deepEqual((await f.ports.a.list()).filter((peer) => peer.self), [
      { id: 'a', title: 'a', running: false, self: true },
    ])
    const answer = f.ports.a.ask(
      { to: 'b', task: 'review src' },
      new AbortController().signal
    )
    await until(() => f.sent.length === 1)
    const request = f.sent[0]!
    assert.equal(request.sandbox, true)
    assert.equal(request.permissionMode, 'ask-every-time')
    assert.deepEqual(request.executionModes, [])
    assert.equal(f.prepared[0]?.sessionId, 'b')
    assert.equal(f.prepared[0]?.projectRoot, f.projectRoot)
    assert.equal(f.members.length, 3)
    let answered = false
    void answer.then(() => {
      answered = true
    })
    f.complete({ ...request, inputId: 'unrelated-input' })
    await Promise.resolve()
    assert.equal(answered, false)
    f.complete(request)
    assert.equal((await answer).session, request.sessionId)
    assert.equal(f.outcomes.size, 0)
  } finally {
    await f.close()
  }
})

test('tell appends guidance to the active run without starting another turn', async () => {
  const f = await fixture()
  try {
    f.running.add('b')
    const signal = new AbortController()
    assert.equal(
      (await f.ports.a.tell({ to: 'b', message: 'first' }, signal.signal)).status,
      'queued'
    )
    assert.equal(
      (await f.ports.a.tell({ to: 'b', message: 'second' }, signal.signal)).status,
      'queued'
    )
    signal.abort()
    assert.equal(f.sent.length, 0)
    assert.equal(f.prepared.length, 0)
    assert.equal(f.guidancePreparations.length, 2)
    assert.equal(f.acceptedGuidance.length, 2)
    assert.match(f.guided[0]!.text, /first/u)
    assert.match(f.guided[1]!.text, /second/u)
    f.complete(f.request('b'))
    await Promise.resolve()
    assert.equal(f.sent.length, 0)
  } finally {
    await f.close()
  }
})

test('tell rejects idle targets and withdraws preparation if the target ends before steering', async () => {
  let settleDuringPreparation = (): void => undefined
  const f = await fixture({
    prepareGuidance: () => {
      settleDuringPreparation()
      return Promise.resolve()
    },
  })
  try {
    const signal = new AbortController().signal
    await assert.rejects(f.ports.a.tell({ to: 'b', message: 'idle' }, signal), { code: 'UNAVAILABLE' })
    await assert.rejects(f.ports.a.tell({ to: 'a', message: 'self' }, signal), { code: 'CONFLICT' })
    await assert.rejects(f.ports.a.tell({ to: 'foreign', message: 'removed' }, signal), {
      code: 'NOT_FOUND',
    })
    assert.equal(f.guidancePreparations.length, 0)
    f.running.add('b')
    settleDuringPreparation = () => {
      f.complete(f.request('b'))
      f.running.add('b')
    }
    await assert.rejects(f.ports.a.tell({ to: 'b', message: 'late' }, signal), { code: 'UNAVAILABLE' })
    assert.equal(f.guidancePreparations.length, 1)
    assert.equal(f.cancelled.length, 1)
    assert.equal(f.acceptedGuidance.length, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.guided.length, 0)
    assert.equal(f.settled.size, 0)
  } finally {
    await f.close()
  }
})

test('tell rejects a cancelled preparation and ignores cancellation or display failure after acceptance', async () => {
  const beforeAcceptance = new AbortController()
  const cancelled = await fixture({
    prepareGuidance: () => {
      beforeAcceptance.abort()
      return Promise.resolve()
    },
  })
  try {
    cancelled.running.add('b')
    await assert.rejects(
      cancelled.ports.a.tell({ to: 'b', message: 'cancelled' }, beforeAcceptance.signal)
    )
    assert.equal(cancelled.guided.length, 0)
    assert.equal(cancelled.cancelled.length, 1)
  } finally {
    await cancelled.close()
  }
  const accepted = await fixture({
    acceptGuidance: () => {
      throw new Error('window closed')
    },
  })
  try {
    accepted.running.add('b')
    const afterAcceptance = new AbortController()
    const steer = accepted.runtime.guidance
    accepted.runtime.guidance = async (ref, input) => {
      await steer(ref, input)
      afterAcceptance.abort()
    }
    const result = await accepted.ports.a.tell(
      { to: 'b', message: 'accepted' },
      afterAcceptance.signal
    )
    assert.equal(result.status, 'queued')
    assert.equal(accepted.guided.length, 1)
    assert.equal(accepted.cancelled.length, 0)
    assert.equal(accepted.sent.length, 0)
  } finally {
    await accepted.close()
  }
})

test('rejects cross-project and self targets and detects indirect waiting cycles', async () => {
  const f = await fixture()
  const controller = new AbortController()
  try {
    await assert.rejects(f.ports.a.ask({ to: 'a', task: 'self' }, controller.signal), {
      code: 'CONFLICT',
    })
    await assert.rejects(f.ports.a.ask({ to: 'foreign', task: 'other' }, controller.signal), {
      code: 'NOT_FOUND',
    })
    await assert.rejects(
      f.ports.a.ask({ to: '', task: 'no target' }, controller.signal),
      { code: 'NOT_FOUND' }
    )
    f.running.add('a')
    f.running.add('b')
    f.running.add('c')
    const ab = f.ports.a.ask({ to: 'b', task: 'ab' }, controller.signal)
    const bc = f.ports.b.ask({ to: 'c', task: 'bc' }, controller.signal)
    void ab.catch(() => undefined)
    void bc.catch(() => undefined)
    await until(() => f.settled.size === 2)
    await assert.rejects(f.ports.c.ask({ to: 'a', task: 'ca' }, controller.signal), {
      code: 'CONFLICT',
    })
    controller.abort()
    await Promise.allSettled([ab, bc])
    assert.equal(f.sent.length, 0)
    assert.equal(f.settled.size, 0)
    assert.equal(f.outcomes.size, 0)
  } finally {
    controller.abort()
    await f.close()
  }
})

test('project closure cancels pending asks and releases their subscriptions', async () => {
  const f = await fixture()
  try {
    f.running.add('b')
    const answer = f.ports.a.ask({ to: 'b', task: 'wait' }, new AbortController().signal)
    void answer.catch(() => undefined)
    await until(() => f.settled.size === 1)
    f.peers.releaseProject(f.projectRoot)
    await assert.rejects(answer)
    assert.equal(f.settled.size, 0)
    assert.equal(f.outcomes.size, 0)
    assert.equal(f.sent.length, 0)
  } finally {
    await f.close()
  }
})
