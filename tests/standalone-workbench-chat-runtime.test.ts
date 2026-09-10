import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ChatMessage } from '@shared/contracts'

import {
  applyStandaloneAgentRuntimeEvent,
  applyStandaloneCompletedRunResult,
  beginStandaloneAgentStop,
  hasStandaloneVisibleAssistantReply,
  LegacyNoTextResponse,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneFinalAgentError,
  readStandaloneFinalAgentStatus,
  readStandaloneFinalAgentText,
  readStandaloneModelVisibleText,
  restoreStandaloneRunMarkers,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
  type StandaloneConversationRuntime,
} from '../src/renderer/src/runtime/standaloneWorkbenchChatRuntime'
import { awaitStandaloneAgentStopSettlement } from '../src/renderer/src/runtime/standaloneWorkbenchStopSettlement'

void describe('standalone Workbench conversation runtime', () => {
  void test('projects progress, turn, and retry events using Desktop runtime semantics', () => {
    let runtime = createRuntime()

    runtime = applyStandaloneAgentRuntimeEvent(runtime, {
      kind: 'phase',
      teamPhase: 'building-prompt',
    })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'building-prompt',
      activeTurn: null,
      completedTurns: 0,
      retryAttempt: null,
      retryMaxAttempts: null,
    })

    runtime = applyStandaloneAgentRuntimeEvent(runtime, { kind: 'turn-start', turn: 2 })
    runtime = applyStandaloneAgentRuntimeEvent(runtime, {
      kind: 'reconnecting',
      attempt: 1,
    })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'executing',
      activeTurn: 2,
      completedTurns: 0,
      retryAttempt: 1,
      retryMaxAttempts: null,
    })

    runtime = applyStandaloneAgentRuntimeEvent(runtime, {
      kind: 'retrying-turn',
      turn: 2,
      attempt: 3,
      maxAttempts: 5,
    })
    assert.equal(runtime.connectionRetryAttempt, 3)
    assert.equal(runtime.connectionRetryMaxAttempts, 5)

    runtime = applyStandaloneAgentRuntimeEvent(runtime, { kind: 'turn-end', turn: 2 })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'researching',
      activeTurn: null,
      completedTurns: 2,
      retryAttempt: null,
      retryMaxAttempts: null,
    })
  })

  void test('projects awaiting events into stopped interaction states', () => {
    const waitingForInput = applyStandaloneAgentRuntimeEvent(createRuntime(), {
      kind: 'awaiting-input',
      question: 'Which package?',
    })
    assert.deepEqual(readInteraction(waitingForInput), {
      status: 'awaiting-input',
      teamPhase: 'waiting-confirmation',
      input: 'Which package?',
      confirmation: null,
      detail: null,
    })

    const waitingForConfirmation = applyStandaloneAgentRuntimeEvent(createRuntime(), {
      kind: 'awaiting-confirmation',
      confirmationMessage: 'Allow this tool?',
      confirmationDetail: {
        kind: 'mcp-tool-call',
        serverName: 'browser',
        toolName: 'open',
      },
    })
    assert.deepEqual(readInteraction(waitingForConfirmation), {
      status: 'awaiting-confirmation',
      teamPhase: 'waiting-confirmation',
      input: null,
      confirmation: 'Allow this tool?',
      detail: {
        kind: 'mcp-tool-call',
        serverName: 'browser',
        toolName: 'open',
      },
    })
  })

  void test('projects all terminal events and keeps errors in runtime state', () => {
    const done = applyStandaloneAgentRuntimeEvent(createRuntime(), { kind: 'done' }, 100)
    assert.deepEqual(readTerminal(done), {
      status: 'completed',
      teamPhase: 'completed',
      lastError: null,
      finishedAt: 100,
    })

    const aborted = applyStandaloneAgentRuntimeEvent(
      createRuntime(),
      { kind: 'aborted', message: 'Stopped by the user.' },
      200
    )
    assert.deepEqual(readTerminal(aborted), {
      status: 'aborted',
      teamPhase: null,
      lastError: 'Stopped by the user.',
      finishedAt: 200,
    })

    const failed = applyStandaloneAgentRuntimeEvent(
      createRuntime(),
      { kind: 'error', message: 'Provider unavailable' },
      300
    )
    assert.deepEqual(readTerminal(failed), {
      status: 'failed',
      teamPhase: null,
      lastError: 'Provider unavailable',
      finishedAt: 300,
    })
  })

  void test('keeps stopping authoritative until an abort terminal event settles it', () => {
    const running = { ...createRuntime(), status: 'running' as const, teamPhase: 'executing' as const }
    const stopping = beginStandaloneAgentStop(running)
    assert.equal(stopping.status, 'stopping')
    assert.equal(stopping.teamPhase, null)

    const lateProgress = applyStandaloneAgentRuntimeEvent(stopping, {
      kind: 'phase',
      teamPhase: 'requesting-model',
    })
    assert.equal(lateProgress.status, 'stopping')
    assert.equal(lateProgress.teamPhase, null)
    assert.equal(shouldBlockStandaloneRunSubmission(lateProgress.status, true, false), true)

    const aborted = applyStandaloneAgentRuntimeEvent(
      lateProgress,
      { kind: 'aborted', message: 'Stopped by the user.' },
      250
    )
    assert.equal(aborted.status, 'aborted')
    assert.equal(aborted.lastRunFinishedAt, 250)
  })

  void test('treats a completed run without visible assistant text as a localized failure', () => {
    const user = message('user', [{ type: 'text', text: 'Question' }])
    const noText = applyStandaloneCompletedRunResult(
      createRuntime(),
      [user],
      'No visible response',
      400
    )
    assert.deepEqual(readTerminal(noText), {
      status: 'failed',
      teamPhase: null,
      lastError: 'No visible response',
      finishedAt: 400,
    })

    const answered = applyStandaloneCompletedRunResult(
      createRuntime(),
      [user, message('assistant', [{ type: 'text', text: 'Answer' }])],
      'No visible response',
      500
    )
    assert.equal(answered.status, 'completed')
    assert.equal(answered.lastError, null)
  })

  void test('recognizes error output instead of falling through to completed', () => {
    assert.equal(readStandaloneFinalAgentStatus({ status: 'error' }), 'error')
    assert.equal(
      readStandaloneFinalAgentError({ status: 'error', error: { message: 'Bad key' } }),
      'Bad key'
    )
    assert.equal(readStandaloneFinalAgentText({ response: LegacyNoTextResponse }), null)
  })

  void test('blocks a new submit while a completed event is awaiting its invoke result', () => {
    assert.equal(shouldBlockStandaloneRunSubmission('completed', true, false), true)
    assert.equal(shouldBlockStandaloneRunSubmission('completed', false, false), false)
  })

  void test('bounds stop settlement even when the abort IPC never resolves', async () => {
    const terminalSettlement = new Promise<never>(() => undefined)
    const settlement = await awaitStandaloneAgentStopSettlement({
      requestAbort: () => new Promise<boolean>(() => undefined),
      terminalSettlement,
      readTerminalKind: () => null,
      timeoutMs: 5,
    })

    assert.deepEqual(settlement, { kind: 'timeout' })
  })

  void test('waits through a false abort response so a delayed done terminal can win', async () => {
    let terminalKind: 'done' | null = null
    let settleTerminal!: (kind: 'done') => void
    const terminalSettlement = new Promise<'done'>((resolve) => {
      settleTerminal = resolve
    })
    const settlement = await awaitStandaloneAgentStopSettlement({
      requestAbort: async () => {
        setTimeout(() => {
          terminalKind = 'done'
          settleTerminal('done')
        }, 5)
        return false
      },
      terminalSettlement,
      readTerminalKind: () => terminalKind,
      timeoutMs: 100,
    })

    assert.deepEqual(settlement, { kind: 'terminal', terminalKind: 'done' })
  })

  void test('removes legacy pseudo replies, error-tone text, and empty model messages', () => {
    const messages = [
      message('assistant', [{ type: 'text', text: LegacyNoTextResponse }], 'legacy'),
      message('assistant', [{ type: 'text', text: 'Provider failed', tone: 'error' }], 'error'),
      message('assistant', [{ type: 'text', text: '   ' }], 'empty'),
      message('user', [{ type: 'text', text: 'Next question' }], 'user'),
      message('assistant', [
        { type: 'text', text: 'Real answer' },
        { type: 'text', text: 'Old failure', tone: 'error' },
      ], 'answer'),
    ] satisfies ChatMessage[]

    const restored = sanitizeStandaloneChatMessages(messages)
    assert.deepEqual(restored.map(({ id }) => id), ['user', 'answer'])
    assert.equal(readStandaloneModelVisibleText(restored[1]!), 'Real answer')
    assert.equal(hasStandaloneVisibleAssistantReply(restored), true)
    assert.equal(
      hasStandaloneVisibleAssistantReply([
        message('assistant', [{ type: 'text', text: 'Earlier answer' }]),
        message('user', [{ type: 'text', text: 'Unanswered question' }]),
      ]),
      false
    )
  })

  void test('pauses run guidance that the interrupted run never consumed', () => {
    const guidance = (id: string, guidanceStatus: ChatMessage['guidanceStatus']): ChatMessage => ({
      ...message('user', [{ type: 'text', text: id }], id),
      conversationKind: 'run-guidance',
      guidanceStatus,
    })
    const messages = [
      guidance('applied', 'applied'),
      guidance('accepted', 'accepted'),
      guidance('in-flight', 'pending'),
      guidance('continuation', 'sent'),
    ]
    const statuses = (settled: readonly ChatMessage[]) =>
      settled.map(({ id, guidanceStatus }) => [id, guidanceStatus])

    // 收尾：已受理未读走的暂停；「引导中」等投递回执自己落定；已纳入 / 续接消息不动。
    assert.deepEqual(statuses(pauseUnappliedRunGuidance(messages)), [
      ['applied', 'applied'],
      ['accepted', 'paused'],
      ['in-flight', 'pending'],
      ['continuation', 'sent'],
    ])
    // 重启恢复：那一轮早就不在了，「引导中」也一并暂停。
    assert.deepEqual(statuses(pauseUnappliedRunGuidance(messages, { includePending: true })), [
      ['applied', 'applied'],
      ['accepted', 'paused'],
      ['in-flight', 'paused'],
      ['continuation', 'sent'],
    ])
  })

  void test('marks the finished run on its last assistant message like Desktop', () => {
    const turn: ChatMessage = { ...message('user', [{ type: 'text', text: 'task' }], 'turn'), conversationKind: 'turn-input' }
    const reply = message('assistant', [{ type: 'text', text: 'done' }], 'reply')
    const base = {
      messages: [turn, reply],
      markers: [],
      lastError: null,
      completedTurns: 3,
      lastRunStartedAt: 1_000,
      lastRunFinishedAt: 4_000,
    }

    assert.deepEqual(markStandaloneRun({ ...base, status: 'completed' }), [
      {
        messageId: 'reply',
        status: 'completed',
        detail: null,
        turnCount: 3,
        turnKind: 'totalTurns',
        startedAt: 1_000,
        durationMs: 3_000,
        timestamp: 4_000,
      },
    ])
    // 运行中不记；同一轮先中止、再来迟到的完成回执时保持中止。
    assert.deepEqual(markStandaloneRun({ ...base, status: 'running' }), [])
    const aborted = markStandaloneRun({ ...base, status: 'aborted', lastError: 'stopped' })
    assert.equal(aborted[0]?.status, 'aborted')
    assert.equal(aborted[0]?.detail, 'stopped')
    assert.equal(markStandaloneRun({ ...base, markers: aborted, status: 'completed' }), aborted)
  })

  void test('does not pin a new run that failed before speaking onto the previous reply', () => {
    const messages: ChatMessage[] = [
      { ...message('user', [{ type: 'text', text: 'first' }], 'turn-1'), conversationKind: 'turn-input' },
      message('assistant', [{ type: 'text', text: 'answer' }], 'reply-1'),
      { ...message('user', [{ type: 'text', text: 'second' }], 'turn-2'), conversationKind: 'turn-input' },
    ]
    const markers = markStandaloneRun({
      messages,
      markers: [],
      status: 'failed',
      lastError: 'provider down',
      completedTurns: 0,
      lastRunStartedAt: 1,
      lastRunFinishedAt: 2,
    })
    assert.deepEqual(markers, [])
  })

  void test('restores only terminal markers of messages still in the session', () => {
    const messages = [message('assistant', [{ type: 'text', text: 'kept' }], 'kept')]
    assert.deepEqual(
      restoreStandaloneRunMarkers(
        [
          { messageId: 'kept', status: 'completed', timestamp: 5, turnCount: 2, startedAt: 1, durationMs: 4 },
          { messageId: 'gone', status: 'completed', timestamp: 5 },
          { messageId: 'kept', status: 'awaiting-input', timestamp: 5 },
          'garbage',
        ],
        messages
      ),
      [
        {
          messageId: 'kept',
          status: 'completed',
          detail: null,
          turnCount: 2,
          turnKind: 'totalTurns',
          startedAt: 1,
          durationMs: 4,
          timestamp: 5,
        },
      ]
    )
    assert.deepEqual(restoreStandaloneRunMarkers(undefined, messages), [])
  })
})

function createRuntime(): StandaloneConversationRuntime {
  return {
    status: 'idle',
    teamPhase: null,
    activeTurn: null,
    completedTurns: 0,
    lastError: null,
    connectionRetryAttempt: null,
    connectionRetryMaxAttempts: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationDetail: null,
    lastRunFinishedAt: null,
  }
}

function message(
  role: ChatMessage['role'],
  blocks: ChatMessage['blocks'],
  id = `${role}-message`
): ChatMessage {
  return { id, role, blocks, timestamp: 1 }
}

function readProgress(runtime: StandaloneConversationRuntime): Record<string, unknown> {
  return {
    status: runtime.status,
    teamPhase: runtime.teamPhase,
    activeTurn: runtime.activeTurn,
    completedTurns: runtime.completedTurns,
    retryAttempt: runtime.connectionRetryAttempt,
    retryMaxAttempts: runtime.connectionRetryMaxAttempts,
  }
}

function readInteraction(runtime: StandaloneConversationRuntime): Record<string, unknown> {
  return {
    status: runtime.status,
    teamPhase: runtime.teamPhase,
    input: runtime.awaitingInputQuestion,
    confirmation: runtime.awaitingConfirmationMessage,
    detail: runtime.awaitingConfirmationDetail,
  }
}

function readTerminal(runtime: StandaloneConversationRuntime): Record<string, unknown> {
  return {
    status: runtime.status,
    teamPhase: runtime.teamPhase,
    lastError: runtime.lastError,
    finishedAt: runtime.lastRunFinishedAt,
  }
}
