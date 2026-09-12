import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { resolveWorkbenchChatComposerPlaceholder } from '../src/renderer/src/models/chat/workbenchChatComposerPlaceholder'
import {
  isWorkbenchAgentProjectWriteResult,
  WorkbenchGitWorkspaceChangeRefreshDelayMs,
} from '../src/renderer/src/models/git/workbenchGitRefreshTriggers'
import { resolveWorkbenchNavigationSurface } from '../src/renderer/src/models/layout/workbenchSurfaceModel'
import { createCoalescedRefresh } from '../src/renderer/src/support/coalescedRefresh'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 截出 page model 里某个处理函数 / switch 分支的源码。 */
function sliceSource(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `missing ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `missing ${end} after ${start}`)
  return source.slice(from, to)
}

void describe('Workbench navigation surface', () => {
  void test('one rule decides the editor group and the left panel for every destination', () => {
    // 打开文件（含项目外的只读预览）：普通文件区 + 文件树，面板收起时不强行展开。
    assert.deepEqual(resolveWorkbenchNavigationSurface('file'), {
      editorGroup: 'primary',
      leftTool: 'project',
      revealLeftPanel: false,
    })
    assert.deepEqual(resolveWorkbenchNavigationSurface('file-preview'), {
      editorGroup: 'primary',
      leftTool: 'project',
      revealLeftPanel: false,
    })
    // 在资源管理器里定位：就是给人看左侧的，面板收起时展开。
    assert.deepEqual(resolveWorkbenchNavigationSurface('reveal'), {
      editorGroup: 'primary',
      leftTool: 'project',
      revealLeftPanel: true,
    })
    // Git 工作区对比：普通文件区里的对比 + 左侧 Git 面板。
    assert.deepEqual(resolveWorkbenchNavigationSurface('git-diff'), {
      editorGroup: 'primary',
      leftTool: 'commit',
      revealLeftPanel: false,
    })
    // 审核本轮改动：「AI 改动」独占组 + 左侧改动树。
    assert.deepEqual(resolveWorkbenchNavigationSurface('ai-changes'), {
      editorGroup: 'ai-changes',
      leftTool: 'ai-changes',
      revealLeftPanel: true,
    })
  })

  void test('every entry that brings something into view goes through the one navigate entry', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')

    const navigate = sliceSource(pageModel, 'const navigate = useMemoizedFn(', '\n  })\n')
    // 入口先按规则定两侧：普通文件区收起独占组，左侧切面板，需要时展开面板。
    assert.match(navigate, /resolveWorkbenchNavigationSurface\(\s*request\.target\s*\)/u)
    assert.match(navigate, /if \(editorGroup === 'primary'\) showEditorSurface\(\)/u)
    assert.match(navigate, /if \(surface\.activeLeftTool !== leftTool\) surface\.setActiveLeftTool\(leftTool\)/u)
    assert.match(navigate, /if \(revealLeftPanel && !surface\.isFilePanelOpen\) surface\.toggleFilePanel\(\)/u)
    assert.match(navigate, /editorNavigation\.goToLocation\(request\.path, request\.line, request\.column, \{\n\s*focus: request\.focus,/u)

    // 聊天：回答里的路径、改动卡的逐文件打开（项目外走只读预览）、「审核」本轮改动。
    const workspacePath = sliceSource(pageModel, 'async function handleWorkbenchChatWorkspacePathOpen', '\n  }\n')
    assert.match(workspacePath, /await navigate\(\{ target: 'file', path: relativePath \}\)/u)
    const fileChangeOpen = sliceSource(pageModel, 'async function handleWorkbenchChatFileChangeOpen', '\n  }\n')
    assert.match(fileChangeOpen, /await navigate\(\{ target: 'file', path: entry\.path \}\)/u)
    assert.match(fileChangeOpen, /await openFileChangePreview\(entry, entry\.rootPath\)/u)
    const preview = sliceSource(pageModel, 'async function openFileChangePreview', '\n  }\n')
    assert.match(preview, /await navigate\(\{ target: 'file-preview', tab: previewTab \}\)/u)
    const review = sliceSource(pageModel, 'function handleWorkbenchChatRunChangesReview', '\n  }\n')
    assert.match(review, /navigate\(\{ target: 'ai-changes', round: target \}\)/u)

    // Agent：open_file 最后停在第一个文件且不抢焦点；explain_code、reveal、open_diff、读问题。
    const openFiles = sliceSource(pageModel, "case 'open-files': {", "case 'clear-highlights':")
    assert.match(openFiles, /await navigate\(\{\n\s*target: 'file',\n\s*path: primary\.path,[\s\S]*?focus: false,/u)
    assert.match(pageModel, /case 'reveal-path':\n\s*await navigate\(\{ target: 'reveal', path: command\.path \}\)/u)
    assert.match(pageModel, /await navigate\(\{ target: 'git-diff', item \}\)/u)
    const explain = sliceSource(pageModel, "case 'explain-code': {", "case 'clear-explanations':")
    assert.match(explain, /if \(first\) await navigate\(\{ target: 'file', path: first\.path \}\)/u)
    const problems = sliceSource(pageModel, "case 'read-problems': {", "if (command.show)")
    assert.match(problems, /await navigate\(\{\n\s*target: 'file',\n\s*path: shown\.path,[\s\S]*?focus: false,/u)

    // 零散的「收独占组 + 切左侧」不再散落在各个处理函数里：切左侧只剩入口与边沿同步 effect。
    assert.equal(pageModel.match(/setActiveLeftTool\(/gu)?.length, 3)
    assert.doesNotMatch(
      pageModel,
      /showEditorSurface\(\)\n\s*(void |await )?editorNavigation\.(selectFile|goToLocation|openDiff|openLightTab)/u
    )
    assert.doesNotMatch(presentation, /showEditorSurface\(\)\n\s*void editorNavigation\.goToLocation/u)
    assert.match(presentation, /model\.actions\.navigate\(\{ target: 'file', path: pendingFileOpenPath \}\)/u)
  })

  void test('the edge-sync effect keeps its job and documents how it splits work with navigate', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')

    assert.match(pageModel, /与 `navigate` 分工：`navigate` 在同一次提交里把两侧一起定好/u)
    assert.match(pageModel, /if \(aiChangesActive\) setActiveLeftTool\('ai-changes'\)/u)
    assert.match(pageModel, /else if \(activeLeftTool === 'ai-changes'\) setActiveLeftTool\('project'\)/u)
  })
})

void describe('Workbench chat composer placeholder', () => {
  const t = (key: string, params?: { path: string }): string =>
    key === 'workbench.chatAskAboutFile' ? `Ask about ${params?.path}…` : 'Ask Workbench Agent…'

  void test('follows the current-file chip, not the raw editor file', () => {
    assert.equal(resolveWorkbenchChatComposerPlaceholder('src/app.ts', t), 'Ask about src/app.ts…')
    // 用户取消了 chip：提示回到通用提示。
    assert.equal(resolveWorkbenchChatComposerPlaceholder(null, t), 'Ask Workbench Agent…')
  })

  void test('the composer reads the chip state for its placeholder', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(adapter, /placeholder: resolveWorkbenchChatComposerPlaceholder\(includedCurrentFilePath, t\)/u)
    assert.match(adapter, /onDismissWorkbenchCurrentFile: \(\) => setIncludedCurrentFilePath\(null\)/u)
    // 打开别的文件时 chip 重新出现，提示随之回来。
    assert.match(adapter, /setIncludedCurrentFilePath\(currentFilePath\)\n\s*\}, \[currentFilePath\]\)/u)
  })
})

void describe('Workbench Git refresh on workspace changes', () => {
  void test('coalesces a burst of triggers into one refresh after the delay', async () => {
    let runs = 0
    const refresh = createCoalescedRefresh(20, async () => {
      runs += 1
    })

    refresh.schedule()
    refresh.schedule()
    refresh.schedule()
    assert.equal(runs, 0)
    await sleep(40)
    assert.equal(runs, 1)
  })

  void test('never overlaps a running refresh and catches up once after it finishes', async () => {
    let runs = 0
    let concurrent = 0
    let maxConcurrent = 0
    const refresh = createCoalescedRefresh(10, async () => {
      runs += 1
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(40)
      concurrent -= 1
    })

    refresh.schedule()
    await sleep(20)
    // 第一次刷新进行中：几次触发只记一笔补刷。
    refresh.schedule()
    refresh.schedule()
    await sleep(200)
    assert.equal(runs, 2)
    assert.equal(maxConcurrent, 1)
  })

  void test('cancel drops the pending refresh', async () => {
    let runs = 0
    const refresh = createCoalescedRefresh(20, async () => {
      runs += 1
    })

    refresh.schedule()
    refresh.cancel()
    await sleep(40)
    assert.equal(runs, 0)
  })

  void test('the refresh window stays inside 500–800ms', () => {
    assert.ok(WorkbenchGitWorkspaceChangeRefreshDelayMs >= 500)
    assert.ok(WorkbenchGitWorkspaceChangeRefreshDelayMs <= 800)
  })

  void test('recognizes project write tool results on the agent execution stream', () => {
    const toolDone = (result: unknown, error?: string) => ({
      channel: 'agent',
      payload: { type: 'tool-done', toolCallId: 'call-1', result, ...(error ? { error } : {}) },
    })

    assert.equal(isWorkbenchAgentProjectWriteResult(toolDone({ changed: true, changedFiles: ['a.ts'] })), true)
    assert.equal(
      isWorkbenchAgentProjectWriteResult(toolDone({ status: 'rolled_back', changedFiles: ['a.ts'] })),
      true
    )
    // 没改到文件、失败的回执、读工具、正文流都不算。
    assert.equal(isWorkbenchAgentProjectWriteResult(toolDone({ changed: false, changedFiles: [] })), false)
    assert.equal(isWorkbenchAgentProjectWriteResult(toolDone({ changedFiles: ['a.ts'] }, 'denied')), false)
    assert.equal(isWorkbenchAgentProjectWriteResult(toolDone({ content: 'x' })), false)
    assert.equal(
      isWorkbenchAgentProjectWriteResult({ channel: 'agent', payload: { type: 'text-delta', text: 'hi' } }),
      false
    )
    assert.equal(isWorkbenchAgentProjectWriteResult({ channel: 'runtime', payload: {} }), false)
    assert.equal(isWorkbenchAgentProjectWriteResult(null), false)
  })

  void test('Git state owns the refresh triggers; the fetch hooks carry no dead watch options', () => {
    const gitState = readSource('src/renderer/src/hooks/useWorkbenchGitState.ts')
    const summaries = readSource('src/renderer/src/support/useWorkspaceGitSummaries.ts')
    const lineStats = readSource('src/renderer/src/support/useWorkspaceGitLineStats.ts')

    assert.match(gitState, /useWorkspaceFilesChangedRefresh\(\{[\s\S]*?onChanged: workspaceChangeRefresh\.schedule/u)
    assert.match(
      gitState,
      /onAgentExecution\(\(envelope\) => \{\n\s*if \(isWorkbenchAgentProjectWriteResult\(envelope\)\) workspaceChangeRefresh\.schedule\(\)/u
    )
    // 顶栏 +/- 总是跟；完整快照只在 Git 界面开着时跟。
    assert.match(gitState, /refreshLineStatsLatest\.current\(\{ reason: 'files-changed' \}\)/u)
    assert.match(
      gitState,
      /gitSurfacesActiveLatest\.current\n\s*\? refreshSummaryLatest\.current\(\{ reason: 'files-changed' \}\)/u
    )
    // 一轮结束时的刷新保留。
    assert.match(gitState, /reason: 'agent-run-finished'/u)
    for (const source of [gitState, summaries, lineStats])
      assert.doesNotMatch(source, /watchFileChanges|watchSessionWorkspace|refreshKey/u)
  })
})
