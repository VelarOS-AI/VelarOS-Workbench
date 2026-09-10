import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench agent UI and AI changes wiring', () => {
  void test('UI requests travel on the run event stream and come back through Kernel IPC', () => {
    const stack = readSource('src/main/agent/WorkbenchAgentExecutionStack.ts')
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const main = readSource('src/main/index.ts')

    // 每轮的工具上下文拿到只属于这一轮的界面口；一轮结束，挂着的请求一律失败。
    assert.match(stack, /workbenchUi: this\.ui\.forExecution\(\{/u)
    assert.match(stack, /this\.ui\.cancelExecution\(input\.executionId/u)
    // 会话面把界面请求交给页面执行、回执交回主进程，请求本身不进会话内容。
    assert.match(adapter, /readWorkbenchAgentUiRequest\(readAgentEventPayload\(envelope\)\)/u)
    assert.match(adapter, /performWorkbenchAgentUiRequest\(activeExecution\.projectRoot, uiRequest\)/u)
    assert.match(adapter, /window\.velarosWorkbenchKernel\.respondAgentUiRequest\(response\)/u)
    assert.match(main, /resolveAgentUiRequest: \(response\) => agentExecutionStack\.ui\.resolve\(response\)/u)
  })

  void test('the page executes the commands and never steals focus from the chat input', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')

    assert.match(pageModel, /registerWorkbenchAgentUiHandler\(agentUiProjectRoot, handleAgentUiCommand\)/u)
    assert.match(pageModel, /case 'open-file':[\s\S]*?focus: false/u)
    assert.match(editorPanel, /editorRef\.current\?\.selectLines\(navigationRequest\.line, navigationRequest\.endLine, options\)/u)
    assert.match(editor, /if \(options\?\.focus !== false\) view\.focus\(\)/u)
    // 讲解气泡是编辑器扩展，随切文件按存储行号重新锚定。
    assert.match(editor, /workbenchExplanationExtension,/u)
    assert.match(editor, /reanchorWorkbenchComments\(view\)\n\s*syncWorkbenchExplanations\(view\)/u)
  })

  void test('AI changes have a left rail entry, a left panel and an isolated read-only tab group', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const card = readSource('src/renderer/src/runtime/conversation/WorkbenchRunChangesCard.tsx')

    assert.match(presentation, /onClick=\{toggleAiChanges\}/u)
    assert.match(presentation, /data-badge=\{aiChanges\.hasUnseenRounds\}/u)
    assert.match(presentation, /: surface\.activeLeftTool === 'ai-changes'\n\s*\? 'ai-changes'/u)
    assert.match(presentation, /group: 'ai-changes' as const/u)
    assert.match(presentation, /<WorkbenchAiChangeDiffPanel/u)
    assert.match(presentation, /onReviewRunChanges=\{model\.actions\.handleWorkbenchChatRunChangesReview\}/u)
    assert.match(kernel, /leftMode === 'ai-changes' \? \(\n\s*<WorkbenchAiChangesPanel/u)
    // 独占组激活时标签栏只显示这一组，普通文件标签隐藏。
    assert.match(tabBar, /new Set\(\['structure', 'ai-changes'\]\)/u)
    assert.match(editorPanel, /openTabs=\{isolatedTabGroup \? \[\] : openTabs\}/u)
    // 回答末尾改动卡的「查看」打开这一轮的对比，而不是随便开一个文件预览。
    assert.match(card, /scope\.onReviewRound\(\{ sessionId: scope\.sessionId, recordId: summary\.recordId \}\)/u)
  })
})
