import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import type { ActiveContextArtifact } from '@velaros-ai/agent/protocol'

import {
  resolveWorkbenchGoalAutoContinue,
  WorkbenchGoalAutoContinueRoundLimit,
  WorkbenchGoalAutoContinueWindowMs,
} from '../src/renderer/src/models/chat/workbenchGoalAutoContinue'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function goal(goalStatus: string, content = '把 Project 内核拆成可组合的事务组件'): ActiveContextArtifact {
  return {
    id: 'active-goal',
    kind: 'requirement',
    scope: 'session',
    status: goalStatus === 'complete' || goalStatus === 'blocked' ? 'completed' : 'active',
    resourceId: 'session-1',
    title: '目标',
    content,
    metadata: { goal: true, goalStatus },
    createdAt: 1,
    updatedAt: 2,
  } as unknown as ActiveContextArtifact
}

const base = {
  runCompleted: true,
  msSinceRunFinished: 500,
  goal: goal('active'),
  hasQueuedUserInput: false,
  consecutiveAutoRounds: 0,
}

describe('goal auto-continue', () => {
  test('a completed round with an active goal starts the next round', () => {
    assert.deepEqual(resolveWorkbenchGoalAutoContinue(base), {
      kind: 'continue',
      objective: '把 Project 内核拆成可组合的事务组件',
    })
  })

  test('a stopped or failed round is never continued', () => {
    assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, runCompleted: false }).kind, 'skip')
  })

  test('only an active goal pulls the next round', () => {
    for (const status of ['paused', 'complete', 'blocked', 'cancelled', 'removed']) {
      assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, goal: goal(status) }).kind, 'skip', status)
    }
    assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, goal: null }).kind, 'skip')
    assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, goal: goal('active', '  ') }).kind, 'skip')
  })

  test('queued user messages go first', () => {
    assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, hasQueuedUserInput: true }).kind, 'skip')
  })

  test('only reacts to the round that just ended, not to a session reopened later', () => {
    assert.equal(
      resolveWorkbenchGoalAutoContinue({ ...base, msSinceRunFinished: WorkbenchGoalAutoContinueWindowMs + 1 }).kind,
      'skip'
    )
  })

  test('stops after the consecutive round limit', () => {
    assert.equal(
      resolveWorkbenchGoalAutoContinue({ ...base, consecutiveAutoRounds: WorkbenchGoalAutoContinueRoundLimit - 1 }).kind,
      'continue'
    )
    assert.equal(
      resolveWorkbenchGoalAutoContinue({ ...base, consecutiveAutoRounds: WorkbenchGoalAutoContinueRoundLimit }).kind,
      'round-limit'
    )
  })

  test('the continuation is a host system notice that leaves the composer alone', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    // 不冒充用户：以 goal-continuation 系统说明起头，只接在正常完成之后。
    assert.match(adapter, /createStandaloneSystemNotice\(\{[\s\S]*?kind: 'goal-continuation',[\s\S]*?\}\)/u)
    assert.match(adapter, /if \(systemNotice && getState\(projectRoot, providerId\)\.status !== 'completed'\) return false/u)
    // 不动输入框里的草稿、附件和拾取；用户亲自发言时连续轮数清零。
    assert.match(
      adapter,
      /if \(!systemNotice\) \{\s*setPrompt\(''\)\s*setFiles\(\[\]\)\s*setBrowserSelections\(\[\]\)\s*\/\/[^\n]*\n\s*goalAutoContinueRoundsRef\.current\.delete\(chat\.sessionId\)\s*\}/u
    )
    // 续跑的这一轮按目标模式跑：模型不更新目标就想收尾时，收尾门会把它拉回来。
    assert.match(adapter, /await submit\(summary, \[\], \{\s*goalMode: true,\s*systemNotice:/u)
  })
})
