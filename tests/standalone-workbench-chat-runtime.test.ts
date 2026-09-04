import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ChatMessage } from '@shared/contracts'

import {
  applyStandaloneAgentRuntimeEvent,
  applyStandaloneCompletedRunResult,
  hasStandaloneVisibleAssistantReply,
  LegacyNoTextResponse,
  readStandaloneFinalAgentError,
  readStandaloneFinalAgentStatus,
  readStandaloneFinalAgentText,
  readStandaloneModelVisibleText,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
  type StandaloneConversationRuntime,
} from '../src/renderer/src/runtime/standaloneWorkbenchChatRuntime'

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
