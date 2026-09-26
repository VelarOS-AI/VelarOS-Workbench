import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ChatMessage } from '@shared/contracts'
import type { WorkbenchConversationState } from '@shared/workbenchConversation'

import {
  applyStandaloneConversationState,
  attachStandaloneRunChanges,
  beginStandaloneAgentStop,
  LegacyNoTextResponse,
  markStandaloneGuidanceApplied,
  markStandaloneRun,
  pauseUnappliedRunGuidance,
  readStandaloneContextUsageEstimate,
  readStandaloneLiveActivity,
  readStandaloneModelVisibleText,
  readStandaloneTerminalKind,
  resolveStandaloneRunChangesAnchor,
  restoreStandaloneRunMarkers,
  sanitizeStandaloneChatMessages,
  shouldBlockStandaloneRunSubmission,
  type StandaloneConversationRuntime,
} from '../src/renderer/src/runtime/standaloneWorkbenchChatRuntime'
import { awaitStandaloneAgentStopSettlement } from '../src/renderer/src/runtime/standaloneWorkbenchStopSettlement'

void describe('standalone Workbench conversation runtime', () => {
  void test('projects progress, turn, and retry states using Desktop runtime semantics', () => {
    let runtime = createRuntime()

    runtime = apply(runtime, { kind: 'phase', teamPhase: 'building-prompt' })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'building-prompt',
      activeTurn: null,
      completedTurns: 0,
      retryAttempt: null,
      retryMaxAttempts: null,
      retryMessage: null,
    })

    runtime = apply(runtime, { kind: 'turn-start', turn: 2 })
    // 限流等待：主进程给的说明留在状态上，状态行显示它。
    runtime = apply(runtime, {
      kind: 'reconnecting',
      attempt: 1,
      message: '  已到每小时的模型用量上限，约 3 分钟后自动继续。  ',
    })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'executing',
      activeTurn: 2,
      completedTurns: 0,
      retryAttempt: 1,
      retryMaxAttempts: null,
      retryMessage: '已到每小时的模型用量上限，约 3 分钟后自动继续。',
    })
    assert.equal(apply(runtime, { kind: 'reconnecting', attempt: 0 }).connectionRetryAttempt, 1)
    assert.equal(apply(runtime, { kind: 'reconnecting', attempt: 2 }).connectionRetryMessage, null)

    runtime = apply(runtime, { kind: 'turn-end', turn: 2 })
    assert.deepEqual(readProgress(runtime), {
      status: 'running',
      teamPhase: 'researching',
      activeTurn: null,
      completedTurns: 2,
      retryAttempt: null,
      retryMaxAttempts: null,
      retryMessage: null,
    })

    // 认不出的阶段、只管用量与引导回执的状态都不动状态行。
    assert.equal(apply(runtime, { kind: 'phase', teamPhase: 'dreaming' as never }), runtime)
    assert.equal(apply(runtime, { kind: 'input-applied', inputId: 'guidance-1' }), runtime)
    assert.equal(apply(runtime, contextUsage({ percent: 40 })), runtime)
  })

  void test('projects awaiting states into interaction states that the next progress clears', () => {
    const waitingForInput = apply(createRuntime(), {
      kind: 'awaiting-input',
      executionId: 'run-1',
      question: ' Which package? ',
    })
    assert.deepEqual(readInteraction(waitingForInput), {
      status: 'awaiting-input',
      teamPhase: 'waiting-confirmation',
      input: 'Which package?',
      confirmation: null,
      confirmationId: null,
      executionId: 'run-1',
    })

    const waitingForConfirmation = apply(createRuntime(), {
      kind: 'awaiting-confirmation',
      executionId: 'run-2',
      confirmationId: 'request-7',
      confirmationMessage: 'Run rm -rf build?',
    })
    assert.deepEqual(readInteraction(waitingForConfirmation), {
      status: 'awaiting-confirmation',
      teamPhase: 'waiting-confirmation',
      input: null,
      confirmation: 'Run rm -rf build?',
      confirmationId: 'request-7',
      executionId: 'run-2',
    })

    // 卡片答完后主进程推来「执行中」：等待中的请求随之撤下，运行接着跑。
    assert.deepEqual(readInteraction(apply(waitingForConfirmation, { kind: 'phase', teamPhase: 'executing' })), {
      status: 'running',
      teamPhase: 'executing',
      input: null,
      confirmation: null,
      confirmationId: null,
      executionId: null,
    })
    // 输入框答完同理：界面不自己推断恢复，等主进程的状态。
    assert.deepEqual(readInteraction(apply(waitingForInput, { kind: 'phase', teamPhase: 'executing' })), {
      status: 'running',
      teamPhase: 'executing',
      input: null,
      confirmation: null,
      confirmationId: null,
      executionId: null,
    })
  })

  void test('projects all terminal states and keeps errors in runtime state', () => {
    const done = apply(createRuntime(), { kind: 'done' }, 100)
    assert.deepEqual(readTerminal(done), {
      status: 'completed',
      teamPhase: 'completed',
      lastError: null,
      finishedAt: 100,
    })

    const aborted = apply(createRuntime(), { kind: 'aborted', message: 'Stopped by the user.' }, 200)
    assert.deepEqual(readTerminal(aborted), {
      status: 'aborted',
      teamPhase: null,
      lastError: 'Stopped by the user.',
      finishedAt: 200,
    })

    const failed = apply(createRuntime(), { kind: 'error', message: 'Provider unavailable' }, 300)
    assert.deepEqual(readTerminal(failed), {
      status: 'failed',
      teamPhase: null,
      lastError: 'Provider unavailable',
      finishedAt: 300,
    })

    // 每一轮都按自己的收尾时刻记，不沿用上一轮的。
    assert.equal(apply(done, { kind: 'done' }, 400).lastRunFinishedAt, 400)
  })

  void test('tells which states end the run', () => {
    assert.equal(readStandaloneTerminalKind({ kind: 'done', goalStatus: 'complete' }), 'done')
    assert.equal(readStandaloneTerminalKind({ kind: 'aborted', message: 'stopped' }), 'aborted')
    assert.equal(readStandaloneTerminalKind({ kind: 'error', message: 'failed' }), 'error')
    assert.equal(readStandaloneTerminalKind({ kind: 'turn-end', turn: 1 }), null)
    assert.equal(
      readStandaloneTerminalKind({ kind: 'awaiting-input', executionId: 'run', question: 'Which?' }),
      null
    )
  })

  void test('keeps stopping authoritative until an abort terminal state settles it', () => {
    const running = { ...createRuntime(), status: 'running' as const, teamPhase: 'executing' as const }
    const stopping = beginStandaloneAgentStop(running)
    assert.equal(stopping.status, 'stopping')
    assert.equal(stopping.teamPhase, null)

    const lateProgress = apply(stopping, { kind: 'phase', teamPhase: 'requesting-model' })
    assert.equal(lateProgress.status, 'stopping')
    assert.equal(lateProgress.teamPhase, null)
    const lateQuestion = apply(lateProgress, {
      kind: 'awaiting-input',
      executionId: 'run',
      question: 'Continue?',
    })
    assert.equal(lateQuestion.status, 'stopping')
    assert.equal(shouldBlockStandaloneRunSubmission(lateQuestion.status, false, false), true)

    const aborted = apply(lateQuestion, { kind: 'aborted', message: 'Stopped by the user.' }, 250)
    assert.equal(aborted.status, 'aborted')
    assert.equal(aborted.lastRunFinishedAt, 250)
    // 没在跑的会话不进停止中。
    assert.equal(beginStandaloneAgentStop(aborted), aborted)
  })

  void test('reads the context usage the meter shows from the main-process estimate', () => {
    assert.deepEqual(readStandaloneContextUsageEstimate(contextUsage({ percent: 42.5 })), {
      percent: 42.5,
      estimatedTokens: 85_000,
      usableContextWindow: 200_000,
    })
    assert.equal(readStandaloneContextUsageEstimate({ kind: 'usage-telemetry', percent: 10 }), null)
    assert.equal(readStandaloneContextUsageEstimate(contextUsage({ usableContextWindow: 0 })), null)
    assert.equal(readStandaloneContextUsageEstimate(contextUsage({ percent: Number.NaN })), null)
    assert.equal(readStandaloneContextUsageEstimate(undefined), null)
  })

  void test('blocks a new submit while a run is active, stopping, or still settling', () => {
    assert.equal(shouldBlockStandaloneRunSubmission('completed', true, false), true)
    assert.equal(shouldBlockStandaloneRunSubmission('completed', false, false), false)
    assert.equal(shouldBlockStandaloneRunSubmission('completed', false, true), true)
    for (const status of ['running', 'stopping', 'awaiting-input', 'awaiting-confirmation'] as const)
      assert.equal(shouldBlockStandaloneRunSubmission(status, false, false), true)
    for (const status of ['idle', 'aborted', 'failed'] as const)
      assert.equal(shouldBlockStandaloneRunSubmission(status, false, false), false)
  })

  void test('bounds stop settlement even when the cancel IPC never resolves', async () => {
    const terminalSettlement = new Promise<never>(() => undefined)
    const settlement = await awaitStandaloneAgentStopSettlement({
      requestAbort: () => new Promise<boolean>(() => undefined),
      terminalSettlement,
      readTerminalKind: () => null,
      timeoutMs: 5,
    })

    assert.deepEqual(settlement, { kind: 'timeout' })
  })

  void test('waits through a false cancel response so a delayed done terminal can win', async () => {
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
    // 没被清理掉的消息原样交回，不换新引用。
    assert.equal(restored[0], messages[3])
  })

  void test('pauses run guidance that the interrupted run never consumed', () => {
    const messages = [
      guidance('applied', 'applied'),
      guidance('accepted', 'accepted'),
      guidance('in-flight', 'pending'),
      guidance('continuation', 'sent'),
    ]

    // 收尾：已受理未读走的暂停；「引导中」等投递回执自己落定；已纳入 / 续接消息不动。
    assert.deepEqual(readGuidanceStatuses(pauseUnappliedRunGuidance(messages)), [
      ['applied', 'applied'],
      ['accepted', 'paused'],
      ['in-flight', 'pending'],
      ['continuation', 'sent'],
    ])
    // 重启恢复：那一轮早就不在了，「引导中」也一并暂停。
    assert.deepEqual(readGuidanceStatuses(pauseUnappliedRunGuidance(messages, { includePending: true })), [
      ['applied', 'applied'],
      ['accepted', 'paused'],
      ['in-flight', 'paused'],
      ['continuation', 'sent'],
    ])
    // 停止：只暂停主进程说还留着没读走的那几条。
    assert.deepEqual(
      readGuidanceStatuses(
        pauseUnappliedRunGuidance(messages, { includePending: true, inputIds: ['in-flight'] })
      ),
      [
        ['applied', 'applied'],
        ['accepted', 'accepted'],
        ['in-flight', 'paused'],
        ['continuation', 'sent'],
      ]
    )
  })

  void test('marks guidance applied when the runtime reads it into the context', () => {
    const messages = [guidance('in-flight', 'pending'), guidance('accepted', 'accepted')]

    // 回执之前 input-applied 可能先到：「引导中」直接记为已纳入。
    assert.deepEqual(readGuidanceStatuses(markStandaloneGuidanceApplied(messages, 'in-flight')), [
      ['in-flight', 'applied'],
      ['accepted', 'accepted'],
    ])
    const applied = markStandaloneGuidanceApplied(messages, 'accepted')
    assert.deepEqual(readGuidanceStatuses(applied), [
      ['in-flight', 'pending'],
      ['accepted', 'applied'],
    ])
    // 重复回执、不认识的输入都不换新消息列表。
    assert.equal(markStandaloneGuidanceApplied(applied, 'accepted'), applied)
    assert.equal(markStandaloneGuidanceApplied(messages, 'unknown-input'), messages)
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
        goalMode: undefined,
        goalStatus: undefined,
        runChanges: undefined,
        timestamp: 4_000,
      },
    ])
    // 运行中不记；同一轮先中止、再来迟到的完成回执时保持中止。
    assert.deepEqual(markStandaloneRun({ ...base, status: 'running' }), [])
    const aborted = markStandaloneRun({ ...base, status: 'aborted', lastError: 'stopped' })
    assert.equal(aborted[0]?.status, 'aborted')
    assert.equal(aborted[0]?.detail, 'stopped')
    assert.equal(markStandaloneRun({ ...base, markers: aborted, status: 'completed' }), aborted)

    // 目标模式的一轮记下目标模式与主进程报来的目标状态。
    const goalRun = markStandaloneRun({ ...base, status: 'completed', goalMode: true, goalStatus: 'complete' })
    assert.equal(goalRun[0]?.goalMode, true)
    assert.equal(goalRun[0]?.goalStatus, 'complete')
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
          {
            messageId: 'kept',
            status: 'completed',
            timestamp: 5,
            turnCount: 2,
            startedAt: 1,
            durationMs: 4,
            goalMode: true,
            goalStatus: 'blocked',
          },
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
          goalMode: true,
          goalStatus: 'blocked',
          runChanges: undefined,
          timestamp: 5,
        },
      ]
    )
    assert.equal(
      restoreStandaloneRunMarkers(
        [{ messageId: 'kept', status: 'completed', timestamp: 5, goalStatus: 'unknown' }],
        messages
      )[0]?.goalStatus,
      undefined
    )
    assert.deepEqual(restoreStandaloneRunMarkers(undefined, messages), [])
  })

  void test('tells what a run is doing now: the retry notice, the thinking stage, else the running script', () => {
    const idle = { liveTraceSummary: undefined, hasStreamingThinkingBlock: false }

    assert.deepEqual(
      readStandaloneLiveActivity(
        message('assistant', [{ type: 'thinking', text: '### 检查项目结构\n继续处理' }]),
        null
      ),
      { liveTraceSummary: '检查项目结构', hasStreamingThinkingBlock: true }
    )
    // 半句还没说完的思考不逐字刷状态行。
    assert.deepEqual(
      readStandaloneLiveActivity(message('assistant', [{ type: 'thinking', text: '让我' }]), null),
      { liveTraceSummary: undefined, hasStreamingThinkingBlock: true }
    )

    const running = message('assistant', [
      { type: 'text', text: '先看一下入口。' },
      script('script-1', '读取入口文件', 'succeeded'),
      script('script-2', '运行类型检查', 'running'),
    ])
    assert.deepEqual(readStandaloneLiveActivity(running, null), {
      liveTraceSummary: '运行类型检查',
      hasStreamingThinkingBlock: false,
    })
    assert.equal(
      readStandaloneLiveActivity(message('assistant', [script('script-3', '整理改动', 'writing')]), null)
        .liveTraceSummary,
      '整理改动'
    )
    // 限流、重试时主进程的说明优先，还没开口时也照样显示。
    assert.equal(readStandaloneLiveActivity(running, '约 3 分钟后自动继续').liveTraceSummary, '约 3 分钟后自动继续')
    assert.deepEqual(readStandaloneLiveActivity(null, '约 3 分钟后自动继续'), {
      liveTraceSummary: '约 3 分钟后自动继续',
      hasStreamingThinkingBlock: false,
    })

    assert.deepEqual(
      readStandaloneLiveActivity(
        message('assistant', [{ type: 'text', text: '好了' }, script('script-4', '收尾', 'succeeded')]),
        null
      ),
      idle
    )
    assert.deepEqual(readStandaloneLiveActivity(message('assistant', [script('script-5', '', 'running')]), null), idle)
    assert.deepEqual(readStandaloneLiveActivity(null, null), idle)
  })

  void test('keeps only a summary of a run\'s file changes on its marker', () => {
    const summary = {
      recordId: 'checkpoint-2',
      capturedAt: 9,
      fileCount: 2,
      additions: 5,
      deletions: 1,
      error: null,
    }
    const messages: ChatMessage[] = [
      { ...message('user', [{ type: 'text', text: 'first' }], 'turn-1'), conversationKind: 'turn-input' },
      message('assistant', [{ type: 'text', text: 'answer' }], 'reply-1'),
      { ...message('user', [{ type: 'text', text: 'second' }], 'turn-2'), conversationKind: 'turn-input' },
      message('assistant', [{ type: 'text', text: 'second answer' }], 'reply-2'),
    ]
    const completed = markStandaloneRun({
      messages,
      markers: [],
      status: 'completed',
      lastError: null,
      completedTurns: 1,
      lastRunStartedAt: 1,
      lastRunFinishedAt: 2,
    })

    // 这一轮的检查点拍在第二条用户消息之前（下标 2）：改动记在这一轮的回答上。
    assert.equal(resolveStandaloneRunChangesAnchor(messages, completed, 2), 'reply-2')
    // 这一轮一条回答都没产出时，最近的回答属于上一轮。
    assert.equal(resolveStandaloneRunChangesAnchor(messages.slice(0, 3), completed, 2), null)

    const attached = attachStandaloneRunChanges(completed, 'reply-2', summary)
    assert.ok(attached)
    assert.deepEqual(attached.markers[0]?.runChanges, summary)
    assert.equal(attached.replacedRecordId, null)
    // 同一条回答换了一份记录：旧记录交给调用方删。
    assert.equal(
      attachStandaloneRunChanges(attached.markers, 'reply-2', { ...summary, recordId: 'checkpoint-3' })
        ?.replacedRecordId,
      'checkpoint-2'
    )
    // 停下、失败的一轮也记改动（文件可能已经改了）；消息已不在会话里、标记不在了才不记。
    assert.equal(
      resolveStandaloneRunChangesAnchor(messages, [{ ...completed[0]!, status: 'aborted' }], 2),
      'reply-2'
    )
    assert.deepEqual(
      attachStandaloneRunChanges([{ ...completed[0]!, status: 'failed' }], 'reply-2', summary)
        ?.markers[0]?.runChanges,
      summary
    )
    assert.equal(attachStandaloneRunChanges(completed, 'removed-reply', summary), null)
    // 同一条回答再记一次运行标记（迟到的完成回执），摘要不丢。
    assert.deepEqual(
      markStandaloneRun({
        messages,
        markers: attached.markers,
        status: 'completed',
        lastError: null,
        completedTurns: 2,
        lastRunStartedAt: 1,
        lastRunFinishedAt: 3,
      })[0]?.runChanges,
      summary
    )
    // 摘要随会话持久化；形状不对的当没有。
    assert.deepEqual(restoreStandaloneRunMarkers(attached.markers, messages)[0]?.runChanges, summary)
    assert.equal(
      restoreStandaloneRunMarkers(
        [{ ...attached.markers[0], runChanges: { recordId: 'x', fileCount: -1 } }],
        messages
      )[0]?.runChanges,
      undefined
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
    connectionRetryMessage: null,
    awaitingInputQuestion: null,
    awaitingConfirmationMessage: null,
    awaitingConfirmationId: null,
    awaitingConfirmationExecutionId: null,
    lastRunFinishedAt: null,
  }
}

function apply(
  runtime: StandaloneConversationRuntime,
  state: WorkbenchConversationState,
  now?: number
): StandaloneConversationRuntime {
  return applyStandaloneConversationState(runtime, state, now)
}

function contextUsage(
  overrides: Partial<Extract<WorkbenchConversationState, { kind: 'context-usage-estimate' }>> = {}
): Extract<WorkbenchConversationState, { kind: 'context-usage-estimate' }> {
  return {
    kind: 'context-usage-estimate',
    turn: 1,
    model: 'gpt-5.6-sol',
    estimatedTokens: 85_000,
    contextWindow: 272_000,
    usableContextWindow: 200_000,
    reservedOutputTokens: 72_000,
    percent: 42.5,
    timestamp: 1_000,
    ...overrides,
  }
}

function message(
  role: ChatMessage['role'],
  blocks: ChatMessage['blocks'],
  id = `${role}-message`
): ChatMessage {
  return { id, role, blocks, timestamp: 1 }
}

function guidance(id: string, guidanceStatus: ChatMessage['guidanceStatus']): ChatMessage {
  return {
    ...message('user', [{ type: 'text', text: id }], id),
    conversationKind: 'run-guidance',
    guidanceStatus,
  }
}

function readGuidanceStatuses(messages: readonly ChatMessage[]): unknown[] {
  return messages.map(({ id, guidanceStatus }) => [id, guidanceStatus])
}

function script(
  id: string,
  title: string,
  status: 'writing' | 'running' | 'succeeded' | 'failed' | 'cancelled'
): ChatMessage['blocks'][number] {
  return {
    type: 'script-execution',
    id,
    kind: 'execute',
    title,
    status,
    source: '',
    sourceTruncated: false,
    calls: [],
    durationMs: null,
  }
}

function readProgress(runtime: StandaloneConversationRuntime): Record<string, unknown> {
  return {
    status: runtime.status,
    teamPhase: runtime.teamPhase,
    activeTurn: runtime.activeTurn,
    completedTurns: runtime.completedTurns,
    retryAttempt: runtime.connectionRetryAttempt,
    retryMaxAttempts: runtime.connectionRetryMaxAttempts,
    retryMessage: runtime.connectionRetryMessage,
  }
}

function readInteraction(runtime: StandaloneConversationRuntime): Record<string, unknown> {
  return {
    status: runtime.status,
    teamPhase: runtime.teamPhase,
    input: runtime.awaitingInputQuestion,
    confirmation: runtime.awaitingConfirmationMessage,
    confirmationId: runtime.awaitingConfirmationId,
    executionId: runtime.awaitingConfirmationExecutionId,
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
