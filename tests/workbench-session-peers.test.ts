import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import type { SessionAnswer } from '@velaros-ai/velaros/sessions/contracts'

import type {
  WorkbenchConversationRef,
  WorkbenchConversationRunOutcome,
  WorkbenchConversationRuntimeApi,
} from '../src/main/conversation/WorkbenchConversationRuntime'
import { WorkbenchSessionPeers } from '../src/main/conversation/WorkbenchSessionPeers'
import type { WorkbenchConversationSendRequest } from '../src/shared/workbenchConversation'
import type { WorkbenchPeerMember, WorkbenchPeerTask } from '../src/shared/workbenchSessionPeers'

async function fixture() {
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
  const failed: string[] = []
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
    WorkbenchConversationRuntimeApi,
    'isRunning' | 'subscribeRunSettled' | 'subscribeRunOutcome' | 'submit'
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
    submit: (_sink, request) => {
      assert(!running.has(request.sessionId))
      sent.push(request)
      running.add(request.sessionId)
      return { accepted: Promise.resolve(), completed: Promise.resolve() }
    },
  }
  const peers = new WorkbenchSessionPeers({
    runtime,
    catalog: () => members,
    prepare: async (task) => {
      prepared.push(task)
      if (task.newSession) members.push({ sessionId: task.sessionId, title: null })
      return { notice: () => undefined, state: () => undefined }
    },
    cancelPreparation: () => undefined,
    failure: (_ref, message) => failed.push(message),
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
    failed,
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

test('peers use the project catalog, inherit execution settings and return only their own input outcome', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.ports.a.list()).filter((peer) => peer.self)[0]?.id, 'a')
    const answer = f.ports.a.ask(
      { workspace: 'project', root: f.projectRoot, task: 'review src' },
      new AbortController().signal
    )
    await until(() => f.sent.length === 1)
    const request = f.sent[0]!
    assert.equal(request.sandbox, true)
    assert.equal(request.permissionMode, 'ask-every-time')
    assert.deepEqual(request.executionModes, [])
    assert.equal(f.prepared[0]?.newSession, true)
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

test('queued messages are delivered in order and survive the sender finishing', async () => {
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
    f.complete(f.request('b'))
    await until(() => f.sent.length === 1)
    assert.match(f.sent[0]!.text, /first/u)
    f.complete(f.sent[0]!)
    await until(() => f.sent.length === 2)
    assert.match(f.sent[1]!.text, /second/u)
  } finally {
    await f.close()
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
      f.ports.a.ask({ workspace: 'system', task: 'system' }, controller.signal),
      { code: 'PERMISSION' }
    )
    await assert.rejects(
      f.ports.a.ask({ workspace: 'project', root: tmpdir(), task: 'outside' }, controller.signal),
      { code: 'PERMISSION' }
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

test('project closure cancels pending asks and queued delivery; removed targets report failure', async () => {
  const f = await fixture()
  try {
    f.running.add('b')
    await f.ports.a.tell({ to: 'b', message: 'review' }, new AbortController().signal)
    f.members.splice(
      f.members.findIndex((member) => member.sessionId === 'b'),
      1
    )
    f.complete(f.request('b'))
    await until(() => f.failed.length === 1)
    assert.equal(f.sent.length, 0)
    f.members.push({ sessionId: 'b', title: null })
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
