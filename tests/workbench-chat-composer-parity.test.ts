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
    assert.match(adapter, /return sendRunGuidance\(text, selections, referencedFilePaths\)/)
    // 中止 / 失败后的下一条消息续接被打断的那一轮，而不是另起新一轮。
    assert.match(adapter, /const continuesInterruptedRun = isInterruptedRunStatus\(/)
    assert.match(adapter, /conversationKind: 'run-guidance' as const, guidanceStatus: 'sent' as const/)
    // 用户按了停止或本轮失败：排队保留但不自动发出。
    assert.match(
      adapter,
      /pauseAutomaticDrain: chat\.status === 'stopping' \|\| isInterruptedRunStatus\(chat\.status\)/
    )
  })

  void test('wires rewind, editor navigation and picked browser elements like Desktop', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 回溯：每轮开跑前拍检查点；只对原生执行栈开放入口。
    assert.match(adapter, /await captureRunCheckpoint\(/)
    assert.match(
      adapter,
      /providerId === 'workbench'\s*\?\s*\{ onRewindToMessage: stableRewindToMessage, getRewindPlan: stableRewindPlan \}/
    )
    // 回答里的路径、改动卡与「查看改动」落到宿主编辑器。
    assert.match(adapter, /onOpenProjectPath=\{onOpenWorkspacePath\}/)
    assert.match(adapter, /onOpenFileChange=\{onOpenFileChange\}/)
    assert.match(adapter, /onReviewFileChanges=\{onReviewFileChanges\}/)
    // 浏览器里拾取的元素进入输入框 chip，随消息带给模型。
    assert.match(adapter, /browserElementSelections: browserSelections/)
    assert.match(adapter, /onBrowserElementSelectionsConsumed\?\.\(/)
    assert.match(
      adapter,
      /\[\s*currentFileContext,\s*fileReferenceContext,\s*attachmentContext,\s*browserElementContext,\s*\]/
    )
  })

  void test('isolates a message that fails to render instead of unmounting the conversation', () => {
    const slots = readFileSync(
      path.resolve(
        process.cwd(),
        'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx'
      ),
      'utf8'
    )

    assert.match(slots, /renderMessageBoundary: \(\{ message, children \}\) =>/)
    assert.match(slots, /<WorkbenchMessageRenderBoundary message=\{message\}>/)
  })

  void test('shows what each run changed on disk like Desktop, keeping the patches out of localStorage', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )
    const slots = readFileSync(
      path.resolve(
        process.cwd(),
        'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx'
      ),
      'utf8'
    )

    assert.match(slots, /messageFileChangeSummary: \(\{ message, formatPathForDisplay, onOpenEntry, onReviewEntries \}\) =>/)
    // 一轮收尾后拿开跑前的检查点比出本轮改动（由这一轮的采集在 finish 时发出）；补丁落主进程记录文件，标记上只挂摘要。
    assert.match(adapter, /settle: \(\) => captureRunChanges\(sessionId, checkpoint\)/)
    assert.doesNotMatch(adapter, /workspaceCheckpointDiff/)
    // 回溯掉的回答、被移除的会话，连同它们的改动记录一起清掉。
    assert.match(adapter, /releaseRunChangeRecords\(projectRoot, sessionId, droppedRunChangeRecordIds\)/)
    assert.match(adapter, /releaseRemovedSession\(target\)/)
    assert.match(adapter, /releaseRunChangeRecords\(session\.projectRoot, session\.sessionId\)/)
  })

  void test('shows the goal card above the composer like Desktop', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )
    const slots = readFileSync(
      path.resolve(
        process.cwd(),
        'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx'
      ),
      'utf8'
    )

    assert.match(slots, /content\.kind === 'goal-lifecycle' \? \(\s*<WorkbenchGoalDockCard/)
    // 目标卡的「继续」空闲时按目标模式另起一轮，运行中经动作端口投引导（Desktop continueGoal 同一分工）。
    assert.match(adapter, /onContinueGoal=\{\(guidance\) => submit\(guidance, \[\], \{ goalMode: true \}\)\}/)
    assert.match(adapter, /\(options\?\.goalMode \?\? goalMode\) \? \['goal' as const\]/)
  })

  void test('shows what the run is doing, the answer cost and the last scroll position like Desktop', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 状态行：思考阶段名或正在跑的工具；翻译器走会话 UI 组合根注入的那一份，不碰进程级默认实例。
    assert.match(adapter, /hasStreamingThinkingBlock: liveActivity\.hasStreamingThinkingBlock/)
    assert.match(adapter, /liveTraceSummary: liveActivity\.liveTraceSummary/)
    assert.match(adapter, /conversationTranslator = useConversationTranslatorRuntime\(\)/)
    // 回答末尾的约价：当前模型 + 公开价格目录。
    assert.match(adapter, /const pricingCatalog = useStandaloneModelPricing\(\)/)
    assert.match(adapter, /billingModel,\n\s*pricingCatalog,/)
    // 每个会话记住自己的滚动位置。
    assert.match(adapter, /\{ restoreKey: chat\.sessionId, readScrollTop, writeScrollTop \}/)
    // 输入框里的附件可以点开。
    assert.match(adapter, /onOpenFile: openAttachedFile/)
  })

  void test('updates the context usage gauge when each turn is estimated, not only when the run ends', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 输入框控件按依赖重算：用量每轮送核前到达一次，必须在依赖里。
    assert.match(adapter, /<WorkbenchContextUsageIndicator usage=\{chat\.contextUsage\} \/>/)
    assert.match(adapter, /chat\.status,\n\s*\/\/[^\n]*\n\s*chat\.contextUsage,/)
    // 上一轮的用量随会话留存，重新打开对话时直接显示。
    assert.match(adapter, /\.\.\.\(state\.contextUsage \? \{ contextUsage: state\.contextUsage \} : \{\}\)/)
    assert.match(adapter, /contextUsage: readStandaloneContextUsageEstimate\(\{\n\s*\.\.\.asRecord\(stored\.contextUsage\),/)
  })

  void test('marks finished runs so answers fold and stopped runs show their status', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    assert.match(adapter, /messageRunMarkers: \[\.\.\.chat\.messageRunMarkers\]/)
    // 四个收尾点（流内终态事件、执行报错、完成、中止）都经同一个标记函数。
    assert.equal(adapter.match(/withRunMarker\(/g)?.length, 5)
    assert.match(adapter, /messageRunMarkers: restoreStandaloneRunMarkers\(stored\.messageRunMarkers, messages\)/)
  })
})
