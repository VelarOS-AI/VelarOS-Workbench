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

  void test('sends like Desktop: queue mid-run, explicit guidance from the queue', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 运行中输入统一排队，只有队列项的发送动作向当前任务追加引导。
    // 外部引擎不收运行中的引导：它跑着时发的消息排队，这一轮结束后再发。
    assert.match(
      adapter,
      /const canSteerRun = chat\.status === 'running' && hasActiveRun && !engine\n/
    )
    assert.match(
      adapter,
      /const engineRunActive = !!engine && chat\.status === 'running' && hasActiveRun\n/
    )
    assert.match(adapter, /canEnqueue: canSteerRun \|\| engineRunActive,/)
    assert.match(
      adapter,
      /return await sendRunGuidance\(\s*text,\s*selections,\s*appendWorkbenchChatFileReferences\(/
    )
    // 引导走会话通道；运行时读进上下文后回执 input-applied，那条引导记为已纳入。
    assert.match(
      adapter,
      /\.guidance\(\{ sessionId, projectRoot, inputId: guidance\.id, text: guidanceText \}\)/
    )
    assert.match(adapter, /markStandaloneGuidanceApplied\(state\.messages, runtime\.inputId\)/)
    // 等一句话回答时输入框就是回答：直接交给主进程，不另起一轮。
    assert.match(adapter, /answer: answerPendingInput,/)
    assert.match(adapter, /answering: isAwaitingInput,/)
    assert.match(adapter, /\.input\(\{ sessionId: chat\.sessionId, projectRoot, answer \}\)/)
    // 中止 / 失败后的下一条消息续接被打断的那一轮，而不是另起新一轮。
    assert.match(adapter, /const continuesInterruptedRun = isInterruptedRunStatus\(/)
    assert.match(
      adapter,
      /conversationKind: 'run-guidance' as const, guidanceStatus: 'sent' as const/
    )
    // 用户按了停止或本轮失败：排队保留但不自动发出。
    assert.match(
      adapter,
      /pauseAutomaticDrain: chat\.status === 'stopping' \|\| isInterruptedRunStatus\(chat\.status\)/
    )
  })

  void test('wires interaction cards, editor navigation and picked browser elements like Desktop', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 交互卡上的回答交给主进程，卡片随后由主进程推来的更新原位写上回答。
    assert.match(adapter, /onAnswerInteraction=\{answerInteraction\}/)
    assert.match(
      adapter,
      /\.answer\(\{ sessionId: chat\.sessionId, projectRoot, requestId, answer \}\)/
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
      /\[text, currentFileContext, fileReferenceContext, attachmentContext, browserElementContext\]/
    )
  })

  void test('offers the Desktop thinking depths, defaults anything else to medium and has no voice input', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    assert.match(adapter, /new Set<ReasoningLevel>\(\['low', 'medium', 'high', 'xhigh', 'max'\]\)/)
    assert.match(adapter, /DefaultWorkbenchReasoningLevel: ReasoningLevel = 'medium'/)
    // 没有旧档位的迁移：存的不是这五档之一就用默认档。
    assert.doesNotMatch(adapter, /off: 'low'|ultra: 'max'/)
    assert.match(adapter, /\? \(stored as ReasoningLevel\)\n\s*: DefaultWorkbenchReasoningLevel/)
    // 思考力度按产品记忆，随每一轮与执行模式一起发给主进程。
    assert.match(adapter, /reasoningLevel,\n\s*executionModes,/)
    // Electron 里没有语音识别服务（与 Desktop 相同）。
    assert.match(adapter, /voiceInput: false,/)
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

    assert.match(
      slots,
      /messageFileChangeSummary: \(\{ message, formatPathForDisplay, onOpenEntry, onReviewEntries \}\) =>/
    )
    // 每轮开跑前拍检查点；一轮收尾后拿它比出本轮改动（由这一轮的采集在 finish 时发出）；补丁落主进程记录文件，标记上只挂摘要。
    assert.match(adapter, /const runCheckpoint = await captureRunCheckpoint\(/)
    assert.match(
      adapter,
      /runChangeCapture: createRunChangeCapture\(projectRoot, sessionId, runCheckpoint\)/
    )
    assert.match(adapter, /settle: \(\) => captureRunChanges\(projectRoot, sessionId, checkpoint\)/)
    assert.doesNotMatch(adapter, /workspaceCheckpointDiff/)
    // 收尾的最终采集带着标记：主进程等最后一条命令的余量走完再拍，采完关掉这一轮的改动归属账本。
    assert.match(adapter, /baseCommitId,\n\s*final: true,\n\s*\}\)/)
    // 摘要挂不上（这一轮没有回答、采集失败）时撤下「进行中」，记录连同归属账本一起清掉；挂上后被替换掉的旧记录同样清掉。
    assert.match(
      adapter,
      /withdrawLiveRunChanges\(projectRoot, sessionId, checkpoint\.id\)\n\s*releaseRunChangeRecords\(projectRoot, sessionId, \[checkpoint\.id\]\)/
    )
    assert.match(
      adapter,
      /if \(orphaned\) releaseRunChangeRecords\(projectRoot, sessionId, \[orphaned\]\)/
    )
    // 被移除的会话，连同它的检查点与改动记录一起清掉。
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
    assert.match(
      adapter,
      /onContinueGoal=\{\(guidance\) => submit\(guidance, \[\], \{ goalMode: true \}\)\}/
    )
    assert.match(adapter, /\(options\?\.goalMode \?\? context\.goalMode\) \? \['goal' as const\]/)
  })

  void test('shows what the run is doing, the answer cost and the last scroll position like Desktop', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    // 两端从共享 UI 选择当前活动，宿主只提供运行态和等待说明。
    assert.match(adapter, /readConversationLiveActivity\(\s*\{\s*runtime: chat,\s*message: activeAssistantMessage,\s*waitMessage: chat\.connectionRetryMessage,\s*locale,/)
    assert.match(adapter, /hasStreamingThinkingBlock: liveActivity\.hasStreamingThinkingBlock/)
    assert.match(adapter, /liveTraceSummary: liveActivity\.liveTraceSummary/)
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
    assert.match(adapter, /contextUsage: toOptional\(state\.contextUsage\)/)
    assert.match(
      adapter,
      /contextUsage: readStandaloneContextUsageEstimate\(\{\n\s*\.\.\.asRecord\(stored\.contextUsage\),/
    )
  })

  void test('marks finished runs so answers fold and stopped runs show their status', () => {
    const adapter = readFileSync(
      path.resolve(process.cwd(), 'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'),
      'utf8'
    )

    assert.match(adapter, /messageRunMarkers: \[\.\.\.chat\.messageRunMarkers\]/)
    // 所有收尾点（主进程推来的终态、发送失败、停止超时）都经 finishRun 里同一个标记函数，目标模式的一轮带上目标状态。
    assert.equal(adapter.match(/withRunMarker\(/g)?.length, 2)
    assert.match(
      adapter,
      /\.\.\.withRunMarker\(settled, \{\n\s*goalMode: run\.goalMode,\n\s*goalStatus: runtime\.kind === 'done' \? runtime\.goalStatus : undefined,/
    )
    assert.match(
      adapter,
      /messageRunMarkers: restoreStandaloneRunMarkers\(stored\.messageRunMarkers, messages\)/
    )
  })
})
