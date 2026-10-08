import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench AI changes wiring', () => {
  void test('AI changes have a left rail entry, a left panel and an isolated read-only tab group', () => {
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    const editorPanel = readSource('src/renderer/src/components/editor/EditorPanel.tsx')
    const tabBar = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')
    const card = readSource('src/renderer/src/runtime/conversation/WorkbenchRunChangesCard.tsx')

    assert.match(presentation, /onClick=\{toggleAiChanges\}/u)
    // 点开改动面板时编辑区也换成改动：带回打开过的标签，一个都没有就打开最新一轮。
    assert.match(
      presentation,
      /if \(tab\) \{\n\s*aiChanges\.selectTab\(tab\.id\)\n\s*return\n\s*\}\n\s*const newest = aiChanges\.rounds\.find\(\(round\) => !round\.error && round\.fileCount > 0\)\n\s*if \(newest\) void aiChanges\.openRound\(newest, \{ auto: true \}\)/u
    )
    assert.match(presentation, /data-badge=\{aiChanges\.hasUnseenRounds\}/u)
    assert.match(presentation, /: surface\.activeLeftTool === 'ai-changes'\n\s*\? 'ai-changes'/u)
    assert.match(presentation, /group: 'ai-changes' as const/u)
    assert.match(presentation, /<WorkbenchAiChangeDiffPanel/u)
    assert.match(presentation, /onReviewRunChanges=\{model\.actions\.handleWorkbenchChatRunChangesReview\}/u)
    assert.match(kernel, /leftMode === 'ai-changes' \? \(\n\s*<LazyWorkbenchAiChangesPanel/u)
    // 独占组激活时标签栏只显示这一组，普通文件标签隐藏。
    assert.match(tabBar, /new Set\(\['structure', 'ai-changes'\]\)/u)
    assert.match(editorPanel, /openTabs=\{isolatedTabGroup \? \[\] : openTabs\}/u)
    // 回答末尾改动卡的「查看」打开这一轮的对比，而不是随便开一个文件预览。
    assert.match(card, /scope\.onReviewRound\(\{ sessionId: scope\.sessionId, recordId: summary\.recordId \}\)/u)
    // 独占组不再有组名标签与「返回编辑器」按钮：进出由左侧面板与「打开文件」决定。
    assert.doesNotMatch(tabBar, /editorTabGroupHeader|ArrowUUpLeftIcon/u)
  })

  void test('the chat publishes every run\'s changes, live and settled, to the AI changes panel', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const snapshot = /function toSnapshot\([\s\S]*?\n\}\n/u.exec(adapter)?.[0] ?? ''
    const identities = /function readProjectRuntimeFieldIdentities\([\s\S]*?\n\}\n/u.exec(adapter)?.[0] ?? ''

    // 项目级快照带上运行标记（已收尾各轮的改动摘要）与正在跑的这一轮实时采到的改动。
    assert.match(snapshot, /messageRunMarkers: state\.messageRunMarkers,/u)
    assert.match(snapshot, /liveRunChanges: state\.liveRunChanges,/u)
    // 项目级视图按这两样判等：改动一变，页面模型（AI 改动面板）就拿到新的一份。
    assert.match(identities, /state\.messageRunMarkers,\n\s*state\.liveRunChanges,/u)
    // 运行中采到的摘要挂在会话的「进行中」上，从这一轮开跑时的消息数往后算。
    assert.match(
      adapter,
      /liveRunChanges: \{ firstMessageIndex: checkpoint\.captureMessageCount, summary \}/u
    )
    // 回答末尾改动卡的「查看」交给宿主，在编辑区打开这一轮的对比。
    assert.match(adapter, /onReviewRound: onReviewRunChanges,/u)
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
})
