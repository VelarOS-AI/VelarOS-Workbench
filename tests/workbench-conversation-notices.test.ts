import { describe, expect, test } from 'bun:test'

import {
  applyWorkbenchConversationNotice,
  conversationRunMessageId,
  readLeadingComment,
  withExpiredInteractions,
  withoutConversationPreviews,
  withSettledScripts,
  withSettledWorkerThreads,
  type WorkbenchConversationTranscript,
} from '../src/renderer/src/runtime/conversation/workbenchConversationNotices'
import {
  ConversationAgentNotice,
  ConversationInteractionNotice,
  ConversationScriptNotice,
  ConversationTextNotice,
  ConversationThinkingNotice,
  ConversationWidgetNotice,
} from '../src/shared/workbenchConversation'

const Empty: WorkbenchConversationTranscript = { messages: [], workerThreads: [] }
const RunId = 'run-1'
const RunMessageId = conversationRunMessageId(RunId)

function text(phase: 'preview' | 'accepted' | 'rejected', value: string, turnId = 'turn-1') {
  return { id: `conversation:${RunId}:${turnId}`, runId: RunId, turnId, phase, text: value }
}

function script(status: string, source = '// 读一下配置\nconst x = 1', extra: Record<string, unknown> = {}) {
  return {
    id: `conversation:script:${RunId}:turn-1:0`,
    kind: 'execute',
    runId: RunId,
    turnId: 'turn-1',
    status,
    source,
    sourceTruncated: false,
    calls: [],
    error: null,
    durationMs: null,
    ...extra,
  }
}

describe('Workbench conversation notices', () => {
  test('a run keeps every block in one assistant message scoped to the user message', () => {
    const next = applyWorkbenchConversationNotice(Empty, ConversationTextNotice, text('preview', '正在'), {
      runId: 'ui-run',
      turnId: 'ui-turn',
    })
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({
      id: RunMessageId,
      role: 'assistant',
      runId: 'ui-run',
      turnId: 'ui-turn',
    })
    const withThinking = applyWorkbenchConversationNotice(next, ConversationThinkingNotice, {
      id: `conversation:thinking:${RunId}:turn-1`,
      runId: RunId,
      turnId: 'turn-1',
      phase: 'update',
      text: '想一想',
    })
    expect(withThinking.messages).toHaveLength(1)
    expect(withThinking.messages[0]!.blocks.map((block) => block.type)).toEqual(['text', 'thinking'])
  })

  test('a text preview grows in place, stale snapshots are ignored, acceptance settles it', () => {
    let state = applyWorkbenchConversationNotice(Empty, ConversationTextNotice, text('preview', '正在读'))
    state = applyWorkbenchConversationNotice(state, ConversationTextNotice, text('preview', '正在'))
    expect(state.messages[0]!.blocks[0]).toMatchObject({ text: '正在读', preview: true })
    state = applyWorkbenchConversationNotice(state, ConversationTextNotice, text('accepted', '正在读配置'))
    expect(state.messages[0]!.blocks[0]).toMatchObject({ text: '正在读配置' })
    expect((state.messages[0]!.blocks[0] as { preview?: boolean }).preview).toBeUndefined()
    // 接纳之后不再被预览改写
    const unchanged = applyWorkbenchConversationNotice(state, ConversationTextNotice, text('preview', 'x'))
    expect(unchanged).toBe(state)
  })

  test('a rejected preview disappears and takes the empty run message with it', () => {
    const previewed = applyWorkbenchConversationNotice(Empty, ConversationTextNotice, text('preview', '草稿'))
    const rejected = applyWorkbenchConversationNotice(previewed, ConversationTextNotice, text('rejected', ''))
    expect(rejected.messages).toHaveLength(0)
  })

  test('script cards are titled by their leading comment and map call modules for the UI', () => {
    const state = applyWorkbenchConversationNotice(
      Empty,
      ConversationScriptNotice,
      script('succeeded', '// 读一下配置\nconst x = 1', {
        calls: [
          {
            moduleId: 'velaros:project',
            operation: 'read',
            status: 'succeeded',
            effect: 'none',
            input: '{}',
            output: '{}',
            inputTruncated: false,
            outputTruncated: false,
          },
        ],
        durationMs: 12,
      })
    )
    const block = state.messages[0]!.blocks[0]
    expect(block).toMatchObject({
      type: 'script-execution',
      kind: 'execute',
      title: '读一下配置',
      status: 'succeeded',
      durationMs: 12,
    })
    expect(block?.type === 'script-execution' ? block.calls[0]?.module : null).toBe('velaros:project')
    expect(block && 'error' in block).toBe(false)
  })

  test('a discarded script card is removed', () => {
    const written = applyWorkbenchConversationNotice(Empty, ConversationScriptNotice, script('writing'))
    const discarded = applyWorkbenchConversationNotice(written, ConversationScriptNotice, script('discarded'))
    expect(discarded.messages).toHaveLength(0)
  })

  test('interaction cards are replaced in place when answered', () => {
    const card = {
      id: 'request-1',
      runId: RunId,
      kind: 'choice',
      message: '选哪个？',
      status: 'pending',
      options: [{ id: 'a', label: 'A' }],
    }
    const opened = applyWorkbenchConversationNotice(Empty, ConversationInteractionNotice, card)
    const answered = applyWorkbenchConversationNotice(opened, ConversationInteractionNotice, {
      ...card,
      status: 'answered',
      answer: { choices: ['a'] },
    })
    expect(answered.messages[0]!.blocks).toHaveLength(1)
    expect(answered.messages[0]!.blocks[0]).toMatchObject({
      type: 'interaction',
      status: 'answered',
      answer: { choices: ['a'] },
    })
    expect('runId' in answered.messages[0]!.blocks[0]!).toBe(false)
  })

  test('widgets outside the size contract are ignored', () => {
    const widget = { id: 'w1', runId: RunId, title: 'Chart', code: '<svg/>', height: 240 }
    expect(
      applyWorkbenchConversationNotice(Empty, ConversationWidgetNotice, widget).messages[0]!.blocks[0]
    ).toMatchObject({ type: 'widget', id: 'w1' })
    expect(
      applyWorkbenchConversationNotice(Empty, ConversationWidgetNotice, { ...widget, height: 5 })
    ).toBe(Empty)
  })

  test('sub-agents become worker threads anchored to their script card', () => {
    const agent = {
      id: 'conversation:agent:exec-1:job-1:1',
      anchorId: 'conversation:script:run-1:turn-1:0',
      task: '\n  查一下测试\n细节',
      profile: 'worker',
      status: 'running',
      answer: '',
      error: null,
      startedAt: 1,
      updatedAt: 2,
    }
    const state = applyWorkbenchConversationNotice(Empty, ConversationAgentNotice, agent)
    expect(state.messages).toHaveLength(0)
    expect(state.workerThreads[0]).toMatchObject({
      threadId: agent.id,
      anchorId: agent.anchorId,
      title: '查一下测试',
      status: 'running',
      subagentType: 'worker',
      output: null,
    })
    expect(withSettledWorkerThreads(state.workerThreads)[0]!.status).toBe('aborted')
  })

  test('malformed notices never touch the transcript', () => {
    expect(applyWorkbenchConversationNotice(Empty, ConversationScriptNotice, { id: 'x' })).toBe(Empty)
    expect(applyWorkbenchConversationNotice(Empty, 'unknown-kind', {})).toBe(Empty)
  })

  test('run end drops previews, cancels unfinished scripts and expires unanswered cards', () => {
    let state = applyWorkbenchConversationNotice(Empty, ConversationTextNotice, text('preview', '草稿'))
    state = applyWorkbenchConversationNotice(state, ConversationScriptNotice, script('running'))
    state = applyWorkbenchConversationNotice(state, ConversationInteractionNotice, {
      id: 'request-2',
      runId: RunId,
      kind: 'confirm',
      message: '可以吗？',
      status: 'pending',
    })
    const settled = withExpiredInteractions(withSettledScripts(withoutConversationPreviews(state.messages)))
    expect(settled[0]!.blocks.map((block) => block.type)).toEqual(['script-execution', 'interaction'])
    expect(settled[0]!.blocks[0]).toMatchObject({ status: 'cancelled' })
    expect(settled[0]!.blocks[1]).toMatchObject({ status: 'expired' })
  })

  test('the leading comment is only the first non-blank line', () => {
    expect(readLeadingComment('\n\n  // 改配置  \nfoo()')).toBe('改配置')
    expect(readLeadingComment('foo()\n// 不是标题')).toBeNull()
    expect(readLeadingComment('')).toBeNull()
  })
})
