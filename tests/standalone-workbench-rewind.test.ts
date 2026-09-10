import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ChatMessage, ToolCallBlock } from '@shared/contracts'

import {
  appendStandaloneCheckpoint,
  buildRewindNoticeText,
  buildRewindPlan,
  isStoredStandaloneCheckpoint,
  NoRewindFileOutcome,
  resolveRewindFidelity,
  resolveRewindFileCapability,
  selectStandaloneRewind,
  type StandaloneChatCheckpoint,
  surveyRewindRemoval,
} from '../src/renderer/src/runtime/standaloneWorkbenchRewind'

function user(id: string, conversationKind: ChatMessage['conversationKind'] = 'turn-input'): ChatMessage {
  return { id, role: 'user', conversationKind, blocks: [{ type: 'text', text: id }], timestamp: 1 }
}

function assistant(id: string, tools: Array<Partial<ToolCallBlock>> = []): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      { type: 'text', text: id },
      ...tools.map((tool, index): ToolCallBlock => ({
        type: 'tool-call',
        toolCallId: `${id}-tool-${index}`,
        toolName: 'project:edit',
        args: {},
        ...tool,
      })),
    ],
    timestamp: 1,
  }
}

function checkpoint(id: string, captureMessageCount: number, commitId: string | null = 'a'.repeat(40)): StandaloneChatCheckpoint {
  return { id, captureMessageCount, createdAt: 1, commitId }
}

/** 把 key 和参数原样摊开的假翻译，方便断言说明里用了哪几段。 */
function t(key: string, params: Record<string, string | number> = {}): string {
  if (key === 'workbench.chatRewindNoticeListSeparator') return ', '
  const rendered = Object.entries(params).map(([name, value]) => `${name}=${value}`).join(' ')
  return rendered ? `${key}(${rendered})` : key
}

void describe('standalone Workbench rewind', () => {
  const messages = [
    user('turn-1'),
    assistant('reply-1'),
    user('turn-2'),
    assistant('reply-2', [{ result: { changedFiles: ['src/a.ts'] } }, { result: 'ok', toolName: 'project:run' }]),
    user('continue', 'run-guidance'),
    assistant('reply-3', [{ isRunning: true }]),
  ]
  const checkpoints = [checkpoint('c1', 0), checkpoint('c2', 2), checkpoint('c3', 4)]

  void test('picks the checkpoint captured when the target turn started and evicts the later ones', () => {
    const selection = selectStandaloneRewind(messages, checkpoints, 'turn-2')
    assert.ok(selection)
    assert.equal(selection.targetIndex, 2)
    assert.deepEqual(selection.removedMessages.map(({ id }) => id), ['turn-2', 'reply-2', 'continue', 'reply-3'])
    assert.equal(selection.checkpoint?.id, 'c2')
    assert.deepEqual(selection.keptCheckpoints.map(({ id }) => id), ['c1', 'c2'])
    assert.deepEqual(selection.evictedCheckpoints.map(({ id }) => id), ['c3'])
    assert.equal(selectStandaloneRewind(messages, checkpoints, 'missing'), null)
  })

  void test('surveys only finished tool calls and the files they proved they changed', () => {
    const survey = surveyRewindRemoval(selectStandaloneRewind(messages, checkpoints, 'turn-2')!.removedMessages)
    assert.deepEqual(survey, {
      removedMessageCount: 4,
      removedTurnCount: 1,
      toolCallCount: 2,
      toolNames: ['project:edit', 'project:run'],
      changedFilePaths: ['src/a.ts'],
      removedNoticeCount: 0,
    })
  })

  void test('offers file rollback only when tools ran and a snapshot exists', () => {
    const noTools = { checkpoint: checkpoint('c', 0), changedFilePaths: [], toolCallCount: 0 }
    assert.deepEqual(resolveRewindFileCapability(noTools), { kind: 'nothing-to-restore' })
    assert.deepEqual(
      resolveRewindFileCapability({ ...noTools, checkpoint: checkpoint('c', 0, null), toolCallCount: 3 }),
      { kind: 'no-snapshot', changedFileCount: 0 }
    )
    const survey = surveyRewindRemoval(messages.slice(2))
    const files = resolveRewindFileCapability({
      checkpoint: checkpoint('c', 2),
      changedFilePaths: survey.changedFilePaths,
      toolCallCount: survey.toolCallCount,
    })
    assert.deepEqual(files, { kind: 'restorable', changedFileCount: 1, rootCount: 1 })
    assert.deepEqual(buildRewindPlan({ survey, files }), {
      removedMessageCount: 4,
      removedTurnCount: 1,
      toolCallCount: 2,
      files,
    })
  })

  void test('leaves a notice for the model unless the removed turns never touched the world', () => {
    const clean = surveyRewindRemoval([user('turn'), assistant('reply')])
    assert.equal(resolveRewindFidelity({ survey: clean, fileOutcome: NoRewindFileOutcome }), 'clean')
    assert.equal(buildRewindNoticeText({ t, fidelity: 'clean', survey: clean, fileOutcome: NoRewindFileOutcome }), null)

    const worldly = surveyRewindRemoval(messages.slice(2))
    const kept = buildRewindNoticeText({
      t,
      fidelity: resolveRewindFidelity({ survey: worldly, fileOutcome: NoRewindFileOutcome }),
      survey: worldly,
      fileOutcome: NoRewindFileOutcome,
    })
    assert.equal(kept?.summary, 'workbench.chatRewindNoticeSummaryDiverged(turns=1 messages=4)')
    assert.match(kept?.detail ?? '', /chatRewindNoticeRemoved\(turns=1 messages=4 tools=2 toolNames=project:edit, project:run\)/u)
    assert.match(kept?.detail ?? '', /chatRewindNoticeFilesKept\(files=src\/a\.ts\)/u)

    const restoredOutcome = { attempted: true, restored: true, error: null }
    assert.equal(resolveRewindFidelity({ survey: worldly, fileOutcome: restoredOutcome }), 'files-restored')
    const failedOutcome = { attempted: true, restored: false, error: 'read-tree failed' }
    const failed = buildRewindNoticeText({
      t,
      fidelity: resolveRewindFidelity({ survey: worldly, fileOutcome: failedOutcome }),
      survey: worldly,
      fileOutcome: failedOutcome,
    })
    assert.match(failed?.detail ?? '', /chatRewindNoticeFilesRestoreFailed\(error=read-tree failed\)/u)

    // 连带删掉上一次回溯说明时，即使这次零工具调用也不能算干净。
    const carried = surveyRewindRemoval([user('turn'), user('notice', 'system-notice')])
    assert.equal(resolveRewindFidelity({ survey: carried, fileOutcome: restoredOutcome }), 'diverged')
  })

  void test('keeps at most 80 checkpoints and validates persisted ones', () => {
    let timeline: StandaloneChatCheckpoint[] = []
    let evicted: StandaloneChatCheckpoint[] = []
    for (let index = 0; index < 81; index += 1) {
      const appended = appendStandaloneCheckpoint(timeline, checkpoint(`c${index}`, index))
      timeline = appended.checkpoints
      evicted = appended.evicted
    }
    assert.equal(timeline.length, 80)
    assert.deepEqual(evicted.map(({ id }) => id), ['c0'])
    assert.equal(isStoredStandaloneCheckpoint(checkpoint('ok', 3, null)), true)
    assert.equal(isStoredStandaloneCheckpoint({ id: 'bad', captureMessageCount: -1, createdAt: 1, commitId: null }), false)
  })
})
