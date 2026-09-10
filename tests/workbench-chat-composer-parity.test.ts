import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

void describe('Workbench chat composer parity', () => {
  void test('delegates side-surface presentation to the shared Platform composer', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    assert.match(adapter, /<ChatSurfaceComposer/)
    assert.match(adapter, /variant="side"/)
    assert.doesNotMatch(adapter, /<ChatComposer(?:\s|>)/)
    assert.doesNotMatch(adapter, /density="compact"/)
  })

  void test('sends like Desktop: guidance mid-run, continuation after an interrupted run', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 运行中（本会话有在途执行）发送 = 引导注入当前这一轮；在途执行是引导的前提，不是阻挡条件。
    assert.match(
      adapter,
      /canSteerRun =\s*providerId === 'workbench' && chat\.status === 'running' && hasPendingAgentExecution/
    )
    assert.match(adapter, /return sendRunGuidance\(text\)/)
    // 中止 / 失败后的下一条消息续接被打断的那一轮，而不是另起新一轮。
    assert.match(adapter, /const continuesInterruptedRun = isInterruptedRunStatus\(/)
    assert.match(adapter, /conversationKind: 'run-guidance' as const, guidanceStatus: 'sent' as const/)
    // 用户按了停止或本轮失败：排队保留但不自动发出。
    assert.match(
      adapter,
      /pauseAutomaticDrain: chat\.status === 'stopping' \|\| isInterruptedRunStatus\(chat\.status\)/
    )
  })
})
