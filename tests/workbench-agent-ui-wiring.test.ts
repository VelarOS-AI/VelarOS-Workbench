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
    assert.match(pageModel, /case 'open-files': \{[\s\S]*?focus: false/u)
    assert.match(editorPanel, /editorRef\.current\?\.selectLines\(navigationRequest\.line, navigationRequest\.endLine, options\)/u)
    assert.match(editor, /if \(options\?\.focus !== false\) view\.focus\(\)/u)
    // 跑命令进底部「运行」面板并把面板打开；预览优先用内置浏览器，没开时交给系统浏览器。
    assert.match(pageModel, /case 'start-run': \{[\s\S]*?surface\.openBottomTool\('run'\)/u)
    assert.match(pageModel, /editorNavigation\.debug\.openTab\(command\.url\)/u)
    assert.match(pageModel, /window\.open\(command\.url, '_blank', 'noopener'\)/u)
    // 问题面板只列当前文件：先把有问题的文件定位到第一个问题再开面板。
    assert.match(pageModel, /await navigate\(\{\n\s*target: 'file',\n\s*path: shown\.path,\n\s*line: firstProblem\.line,\n\s*column: firstProblem\.column,\n\s*focus: false,/u)
    assert.match(pageModel, /if \(command\.show\) surface\.openBottomTool\('problems'\)/u)
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
    // 独占组不再有组名标签与「返回编辑器」按钮：进出由左侧面板与「打开文件」决定。
    assert.doesNotMatch(tabBar, /editorTabGroupHeader|ArrowUUpLeftIcon/u)
  })

  void test('left panel and editor never show different domains', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')

    // 编辑区进入对比 → 左侧切到改动树；编辑区回到普通文件 → 左侧回文件树；左侧离开改动树 → 编辑区收起对比。
    assert.match(pageModel, /if \(aiChangesActive\) setActiveLeftTool\('ai-changes'\)/u)
    assert.match(pageModel, /else if \(activeLeftTool === 'ai-changes'\) setActiveLeftTool\('project'\)/u)
    assert.match(
      pageModel,
      /if \(aiChangesActive && previous\.leftTool === 'ai-changes' && activeLeftTool !== 'ai-changes'\)\n\s*deactivateAiChanges\(\)/u
    )
  })

  void test('AI selections stay locked on the file until its tab closes', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')

    const openFiles = /case 'open-files': \{[\s\S]*?\n {8}\}/u.exec(pageModel)?.[0] ?? ''
    // 一批文件在后台开成标签，不逐个切过去；只给开出了标签的文件标选区，最后停在第一个文件。
    assert.match(openFiles, /if \(await workbench\.preloadOpenTab\(file\.path\)\) opened\.push\(file\)/u)
    assert.match(openFiles, /aiHighlightStore\.add\(\n\s*context\.projectRoot,\n\s*opened\.flatMap/u)
    assert.match(openFiles, /await navigate\(\{\n\s*target: 'file',\n\s*path: primary\.path/u)
    assert.doesNotMatch(openFiles, /editorNavigation\.selectFile/u)
    // AI 用 clear-highlights 取消。
    assert.match(pageModel, /case 'clear-highlights':\n\s*return \{ cleared: aiHighlightStore\.clear\(context\.projectRoot, command\.paths\) \}/u)
    // 关掉标签（任意方式）才释放，换项目整项目释放；改名、移动跟着换路径。
    assert.match(pageModel, /const released = resolveReleasedAiHighlightTabs\(previous, next\)/u)
    assert.match(pageModel, /onOpenEntryPathMoved: aiHighlightStore\.renamePath/u)
    // 编辑器按存储重锚：切文件、外部替换、存储变化都重算；编辑时行号回写。存储变化直接订阅，不重渲染编辑器。
    assert.match(editor, /workbenchAiHighlightExtension,/u)
    assert.match(editor, /syncWorkbenchExplanations\(view\)\n\s*syncWorkbenchAiHighlights\(view\)/u)
    assert.match(editor, /onAnchorLinesChanged: aiHighlightStore\.updateLines/u)
    assert.match(editor, /aiHighlightStore\.subscribe\(resync\(syncWorkbenchAiHighlights\)\)/u)
    assert.doesNotMatch(editor, /useWorkbenchAiHighlights\(\)|useWorkbenchExplanations\(\)/u)
    // 格式化按最小改动应用，选区、讲解、评论不会塌到文件开头。
    assert.match(editor, /view\.dispatch\(\{ changes: buildWorkbenchMinimalTextChanges\(content, nextContent\) \}\)/u)
  })

  void test('the explanation bubble keeps a single icon-only header row', () => {
    const extension = readSource('src/renderer/src/components/editor/workbenchExplanationExtension.ts')

    assert.match(extension, /flexWrap: 'nowrap'/u)
    assert.match(extension, /createActionButton\('cm-wbExplainClose', labels\.close, CloseSvg, \(\) => this\.options\.onCollapse\(\)\)/u)
    // 行号栏里的序号标记：当前这条点了隐藏，其余的点了显示。
    assert.match(extension, /if \(this\.anchor\.active\) this\.options\.onCollapse\(\)\n\s*else this\.options\.onActivate\(this\.anchor\.id\)/u)
    assert.doesNotMatch(extension, /labels\.badge|labels\.finish|onFinish/u)
  })
})
