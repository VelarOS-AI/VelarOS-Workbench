import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { mock, test } from 'bun:test'
import type { WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchBrowserService } from '../src/main/browser/WorkbenchBrowserService'
import type { WorkbenchConversationDispatcherApi } from '../src/main/conversation/WorkbenchConversationDispatcher'
import type { WorkbenchConversationRecovery } from '../src/main/conversation/WorkbenchConversationRecovery'
import type { WorkbenchShellHostRegistryApi } from '../src/main/conversation/WorkbenchShellHostRegistry'
import { WorkbenchAgentProcessesChannels as Agent } from '../src/shared/workbenchAgentProcesses'
import { WorkbenchBrowserChannels as Browser } from '../src/shared/workbenchBrowser'
import {
  WorkbenchConversationChannels as Conversation,
  type WorkbenchConversationSendRequest,
} from '../src/shared/workbenchConversation'
import {
  type WorkbenchPeerEvent,
  type WorkbenchPeerTask,
  WorkbenchSessionPeersChannels as Peers,
} from '../src/shared/workbenchSessionPeers'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
void mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

async function fixture() {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-private-ipc-')))
  const calls: string[] = []
  const admissions: string[] = []
  let retiring = false
  let receivePreparation!: (task: WorkbenchPeerTask) => void
  const preparation = new Promise<WorkbenchPeerTask>((yes) => { receivePreparation = yes })
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      if (channel !== Peers.event) return
      const event = payload as WorkbenchPeerEvent
      if (event.type === 'prepare-guidance') receivePreparation(event.task)
    },
  }) as unknown as WebContents
  const windows = {
    getHubForWebContents: (contents: WebContents) =>
      contents === sender
        ? { getState: () => ({ currentProject: { path: projectRoot, name: 'project' } }) }
        : null,
    getWebContentsForProject: (root: string) => resolve(root) === projectRoot ? sender : null,
    assertProjectForWebContents: (contents: WebContents, root: string): void => {
      admissions.push(root)
      if (contents !== sender || resolve(root) !== projectRoot)
        throw new AppError('PERMISSION', 'project is not owned by this sender')
      if (retiring) throw new AppError('CANCELLED', 'project is retiring')
    },
  }
  const record = (method: string, value?: unknown) => async () => {
    calls.push(method)
    return value
  }
  const runtime = {
    submit: () => {
      calls.push('submit')
      return { accepted: Promise.resolve(), completed: Promise.resolve() }
    },
    guidance: record('guidance'),
    cancel: record('cancel', { aborted: true }),
    input: record('answer-input'),
    answer: record('answer'),
    isRunning: () => true,
    subscribeNotesChanged: () => () => undefined,
    subscribeRunSettled: () => () => undefined,
    subscribeRunOutcome: () => () => undefined,
  } as unknown as WorkbenchConversationDispatcherApi
  const recovery = {
    begin: record('journal-begin'),
    read: record('journal-read', null),
  } as unknown as WorkbenchConversationRecovery
  const shells = {
    listBackgroundTasks: record('console-list', []),
    terminateBackgroundTask: record('console-stop', {}),
    writeConsoleInput: record('console-input', {}),
    interruptConsole: record('console-interrupt', {}),
    addBackgroundTasksListener: () => () => undefined,
  } as unknown as WorkbenchShellHostRegistryApi
  const browser = {
    state: record('browser-state', { projectRoot, sessionId: 'a', site: null }),
    attachPage: record('browser-attach'),
    navigate: record('browser-navigate'),
    detachPage: record('browser-detach'),
    leaveSite: record('browser-leave'),
    onChanged: () => () => undefined,
  } as unknown as WorkbenchBrowserService
  const { registerWorkbenchConversationIpc } = await import('../src/main/conversation/WorkbenchConversationIpc')
  const { registerWorkbenchSessionPeersIpc } = await import('../src/main/conversation/WorkbenchSessionPeersIpc')
  const { registerWorkbenchAgentProcessesIpc } = await import('../src/main/conversation/WorkbenchAgentProcessesIpc')
  const { registerWorkbenchBrowserIpc } = await import('../src/main/browser/WorkbenchBrowserIpc')
  const disposeConversation = registerWorkbenchConversationIpc({
    runtime, recovery, windows: windows as never, backupDir: () => projectRoot,
  })
  const peers = registerWorkbenchSessionPeersIpc({ runtime, recovery, windows: windows as never })
  const disposeAgent = registerWorkbenchAgentProcessesIpc({
    shells, windows: windows as never, focusConsole: () => false,
  })
  const disposeBrowser = registerWorkbenchBrowserIpc({ browser, windows: windows as never })
  const ref = { projectRoot, sessionId: 'a' }
  const request: WorkbenchConversationSendRequest = {
    ...ref,
    inputId: 'input-a',
    text: 'hello',
    locale: 'en-US',
    model: { provider: 'openrouter', model: 'test', apiKey: '', baseURL: '' },
    reasoningLevel: 'low',
    executionModes: [],
    permissionMode: 'standard-open',
    memory: false,
    webSearchEngine: 'google',
  }
  return {
    admissions,
    calls,
    peers: peers.peers,
    preparation,
    ref,
    request,
    retire: () => { retiring = true },
    invoke: async (channel: string, input: unknown): Promise<{ ok: boolean; code?: string }> => {
      const handler = handlers.get(channel)
      assert.ok(handler, `missing IPC handler ${channel}`)
      return (await handler({ sender }, input)) as { ok: boolean; code?: string }
    },
    close: async () => {
      peers.dispose()
      disposeConversation()
      disposeAgent()
      disposeBrowser()
      await rm(projectRoot, { recursive: true, force: true })
    },
  }
}

test('retiring project IPC rejects new resources before their service starts', async () => {
  const f = await fixture()
  try {
    f.retire()
    for (const [channel, input] of [
      [Conversation.send, f.request],
      [Agent.input, { ...f.ref, taskId: 'console-1', text: 'npm run dev\n' }],
      [Browser.attachPage, { ...f.ref, webContentsId: 101 }],
      [Peers.catalog, { projectRoot: f.ref.projectRoot, members: [{ sessionId: 'a', title: null }] }],
    ] as const) {
      const result = await f.invoke(channel, input)
      assert.equal(result.ok, false, channel)
      assert.equal(result.code, 'CANCELLED', channel)
    }
    assert.equal(f.admissions.length, 4)
    assert.deepEqual(f.calls, [])
  } finally {
    await f.close()
  }
})

test('retiring projects still settle admitted peer receipts and existing handles', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.invoke(Peers.catalog, {
      projectRoot: f.ref.projectRoot,
      members: [{ sessionId: 'a', title: 'source' }, { sessionId: 'b', title: 'target' }],
    })).ok, true)
    const port = f.peers.forSession(f.request)
    const delivery = port.tell({ to: 'b', message: 'prepared before retirement' }, new AbortController().signal)
    void delivery.catch(() => undefined)
    const task = await f.preparation
    f.retire()
    const admissions = f.admissions.length
    assert.equal((await f.invoke(Peers.acknowledge, { ...task })).ok, true)
    assert.equal((await delivery).status, 'queued')
    for (const [channel, input] of [
      [Conversation.cancel, f.ref],
      [Conversation.answer, { ...f.ref, requestId: 'question', answer: { text: 'finish existing question' } }],
      [Agent.stop, { ...f.ref, taskId: 'console-1', force: true }],
      [Browser.detachPage, f.ref],
    ] as const)
      assert.equal((await f.invoke(channel, input)).ok, true, channel)
    assert.equal(f.admissions.length, admissions)
    assert.deepEqual(f.calls, ['guidance', 'cancel', 'answer', 'console-stop', 'browser-detach'])
  } finally {
    await f.close()
  }
})
