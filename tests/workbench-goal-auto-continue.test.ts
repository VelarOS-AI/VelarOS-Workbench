import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import type { ActiveContextArtifact } from '@velaros-ai/ui/conversation/contracts'
import type { GoalStatus } from '@velaros-ai/velaros/contracts'

import { goalArtifact } from '../src/main/conversation/WorkbenchConversationRules'
import {
  resolveWorkbenchGoalAutoContinue,
  WorkbenchGoalAutoContinueRoundLimit,
  WorkbenchGoalAutoContinueWindowMs,
} from '../src/renderer/src/models/chat/workbenchGoalAutoContinue'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

/** 主进程经 getGoal 交给会话面的那份目标卡（Platform 的目标状态投影成 ActiveContextArtifact）。 */
function goal(
  status: GoalStatus,
  objective = '把 Project 内核拆成可组合的事务组件'
): ActiveContextArtifact {
  const artifact = goalArtifact('session-1', {
    id: 'active-goal',
    revision: 3,
    objective,
    status,
    reason: '',
    createdAt: 1,
    updatedAt: 2,
  })
  assert.ok(artifact)
  return artifact
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
    for (const status of ['paused', 'complete', 'blocked', 'cancelled', 'removed'] as const) {
      assert.equal(
        resolveWorkbenchGoalAutoContinue({ ...base, goal: goal(status) }).kind,
        'skip',
        status
      )
    }
    assert.equal(resolveWorkbenchGoalAutoContinue({ ...base, goal: null }).kind, 'skip')
    assert.equal(
      resolveWorkbenchGoalAutoContinue({ ...base, goal: goal('active', '  ') }).kind,
      'skip'
    )
  })

  test('queued user messages go first', () => {
    assert.equal(
      resolveWorkbenchGoalAutoContinue({ ...base, hasQueuedUserInput: true }).kind,
      'skip'
    )
  })

  test('only reacts to the round that just ended, not to a session reopened later', () => {
    assert.equal(
      resolveWorkbenchGoalAutoContinue({
        ...base,
        msSinceRunFinished: WorkbenchGoalAutoContinueWindowMs + 1,
      }).kind,
      'skip'
    )
  })

  test('stops after the consecutive round limit', () => {
    assert.equal(
      resolveWorkbenchGoalAutoContinue({
        ...base,
        consecutiveAutoRounds: WorkbenchGoalAutoContinueRoundLimit - 1,
      }).kind,
      'continue'
    )
    assert.equal(
      resolveWorkbenchGoalAutoContinue({
        ...base,
        consecutiveAutoRounds: WorkbenchGoalAutoContinueRoundLimit,
      }).kind,
      'round-limit'
    )
  })

  test('the continuation is a host system notice that leaves the composer alone', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    // 不冒充用户：以 goal-continuation 系统说明起头，只接在正常完成之后。
    assert.match(
      adapter,
      /createStandaloneSystemNotice\(\{[\s\S]*?kind: 'goal-continuation',[\s\S]*?\}\)/u
    )
    assert.match(
      adapter,
      /if \(systemNotice && readSession\(projectRoot, chat\.sessionId\)\?\.status !== 'completed'\)\s*return false/u
    )
    // 不动输入框里的草稿、附件、拾取和挂着的文件引用；用户亲自发言时连续轮数清零。
    assert.match(
      adapter,
      /if \(!systemNotice && !options\?\.queued\) \{\s*consumeStandaloneChatDraft\(submissionKey, \{ value: draftValue, files: draftFiles, context \}\)/u
    )
    assert.match(
      adapter,
      /if \(!systemNotice\) goalAutoContinueRoundsRef\.current\.delete\(chat\.sessionId\)/u
    )
    // 续跑的这一轮按目标模式跑：模型不更新目标就想收尾时，Platform 的完成检查会把它拉回来。
    assert.match(adapter, /await submit\(summary, \[\], \{\s*goalMode: true,\s*systemNotice:/u)
  })

  test('decides from the goal the conversation bridge reads once the round completed', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    // 外部引擎的会话不续跑：目标归引擎自己管。
    const effectStart = adapter.search(
      /if \(chat\.status !== 'completed' \|\| !chat\.lastRunFinishedAt \|\| hasActiveRun \|\| chat\.engine\)\s*return/u
    )
    const effect = adapter.slice(effectStart, adapter.indexOf('\n  }, [', effectStart))

    assert.ok(effectStart >= 0)
    // 目标由主进程按 (项目根, 会话) 读出；读不到按没有目标，不续跑。
    assert.match(
      effect,
      /window\.velarosWorkbenchConversation\s*\.getGoal\(\{ sessionId, projectRoot \}\)/u
    )
    assert.match(effect, /goal: lifecycle\?\.ok \? lifecycle\.value\.goal : null/u)
    // 读目标期间用户发了新消息或切走了会话：不在别的现场续跑。
    assert.match(effect, /current\.lastRunFinishedAt !== finishedAt/u)
    assert.match(effect, /hasQueuedUserInput: queuedDraftCountLatest\.current > 0/u)
    assert.match(
      effect,
      /goalAutoContinueRoundsRef\.current\.set\(sessionId, consecutiveAutoRounds \+ 1\)/u
    )
  })
})
