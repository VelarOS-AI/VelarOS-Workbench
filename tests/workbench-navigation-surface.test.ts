import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  createWorkbenchGitWorkspaceChangeRefresh,
  WorkbenchGitTreeDecorationRefreshDelayMs,
  WorkbenchGitWorkspaceChangeRefreshDelayMs,
} from '../src/renderer/src/hooks/useWorkbenchGitState'
import { resolveWorkbenchChatComposerPlaceholder } from '../src/renderer/src/models/chat/workbenchChatComposerPlaceholder'
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
    // 审核本轮改动：「AI 改动」独占组 + 左侧改动树。
    assert.deepEqual(resolveWorkbenchNavigationSurface('ai-changes'), {
      editorGroup: 'ai-changes',
      leftTool: 'ai-changes',
      revealLeftPanel: true,
    })
    // 项目搜索（⇧⌘F）：搜索在左侧项目面板里，面板收起着就展开；结果在普通文件区打开。
    assert.deepEqual(resolveWorkbenchNavigationSurface('search'), {
      editorGroup: 'primary',
      leftTool: 'project',
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
    assert.match(
      navigate,
      /await editorNavigation\.goToLocation\(request\.path, request\.line, request\.column(?:, \{[^}]*\})?\)/u
    )

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

    // 零散的「收独占组 + 切左侧」不再散落在各个处理函数里：切左侧只剩入口与边沿同步 effect。
    assert.equal(pageModel.match(/setActiveLeftTool\(/gu)?.length, 3)
    assert.doesNotMatch(
      pageModel,
      /showEditorSurface\(\)\n\s*(void |await )?editorNavigation\.(selectFile|goToLocation|openDiff|openLightTab)/u
    )
    assert.doesNotMatch(presentation, /showEditorSurface\(\)\n\s*void editorNavigation\.goToLocation/u)
    assert.match(presentation, /model\.actions\.navigate\(\{ target: 'file', path: pendingFileOpenPath \}\)/u)
  })

  void test('opening a file locates it in the file tree even when it already is the current file', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const treeController = readSource('src/renderer/src/hooks/useWorkbenchTreeController.ts')
    const panel = readSource('src/renderer/src/components/files/FilePanel.tsx')
    const adapter = readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts')
    const tree = readSource('src/renderer/src/components/files/FileTree.tsx')

    // 当前文件不变时「跟着当前文件定位」的 effect 不会动：导航的 file 分支自己无条件定位一次。
    const fileCase = sliceSource(
      sliceSource(pageModel, 'const navigate = useMemoizedFn(', '\n  })\n'),
      "case 'file':",
      "case 'file-preview':"
    )
    assert.match(fileCase, /\n\s*await workbench\.revealEntryPath\(request\.path, \{ quiet: true \}\)\n\s*return/u)
    // 每次定位都记一笔，一路传到文件树：选中项没变（用户滚走了）也要滚回视野。
    assert.match(treeController, /setSelectedEntryPath\(path\)\n\s*setRevealRevision\(\(revision\) => revision \+ 1\)/u)
    assert.match(adapter, /revealRevision: workbench\.revealRevision/u)
    assert.match(panel, /revealRevision=\{revealRevision\}/u)
    assert.match(tree, /if \(!selectionAlreadyMatches\) tree\.select\(selectedPath, \{ focus: false \}\)\n\s*else if \(scrolledRevealRevisionRef\.current !== revealRevision\) void tree\.scrollTo\(selectedPath\)/u)
    assert.match(tree, /\}, \[revealRevision, selectedPath, treeData, treeSize\.measured\]\)/u)
  })

  void test('the edge-sync effect keeps its job and documents how it splits work with navigate', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')

    assert.match(pageModel, /与 `navigate` 分工：`navigate` 在同一次提交里把两侧一起定好/u)
    assert.match(pageModel, /if \(aiChangesActive\) setActiveLeftTool\('ai-changes'\)/u)
    assert.match(pageModel, /else if \(activeLeftTool === 'ai-changes'\) setActiveLeftTool\('project'\)/u)
  })
})

void describe('Workbench chat composer placeholder', () => {
  const t = (key: string, params?: { path: string } | { count: number } | { engine: string }): string =>
    key === 'workbench.chatAskAboutFile' && params && 'path' in params
      ? `Ask about ${params.path}…`
      : key === 'workbench.chatAskAboutFiles' && params && 'count' in params
        ? `Ask about ${params.count} files…`
        : key === 'workbench.chatEnginePlaceholder' && params && 'engine' in params
          ? `Ask ${params.engine}…`
          : 'Ask Workbench Agent…'

  void test('follows the files the message asks about, not the raw editor file', () => {
    assert.equal(resolveWorkbenchChatComposerPlaceholder(['src/app.ts'], t), 'Ask about src/app.ts…')
    // 右键「添加到聊天」又挂了文件：提示说问几个文件。
    assert.equal(
      resolveWorkbenchChatComposerPlaceholder(['src/app.ts', 'src/lib.ts'], t),
      'Ask about 2 files…'
    )
    // 用户取消了 chip：提示回到通用提示；交给外部引擎的会话写引擎的名字。
    assert.equal(resolveWorkbenchChatComposerPlaceholder([], t), 'Ask Workbench Agent…')
    assert.equal(resolveWorkbenchChatComposerPlaceholder([], t, 'Claude Code'), 'Ask Claude Code…')
  })

  void test('the composer reads the chip state for its placeholder', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(
      adapter,
      /placeholder: resolveWorkbenchChatComposerPlaceholder\(askedFilePaths, t, engineLabel\)/u
    )
    assert.match(
      adapter,
      /appendWorkbenchChatFileReferences\(\s*includedCurrentFilePath \? \[includedCurrentFilePath\] : \[\],\s*selectedFileReferencePaths\s*\)/u
    )
    assert.match(adapter, /onDismissWorkbenchCurrentFile: \(\) => setIncludedCurrentFilePath\(null\)/u)
    // 打开别的文件时 chip 重新出现，提示随之回来。
    assert.match(adapter, /setIncludedCurrentFilePath\(currentFilePath\)\n\s*\}, \[currentFilePath\]\)/u)
  })
})

void describe('Workbench Git refresh on workspace changes', () => {
  void test('coalesces a burst of triggers into one refresh after the delay', async () => {
    let runs = 0
    const refresh = createCoalescedRefresh({
      delayMs: 20,
      run: async () => {
        runs += 1
      },
    })

    refresh.schedule()
    refresh.schedule()
    refresh.schedule()
    assert.equal(runs, 0)
    await sleep(40)
    assert.equal(runs, 1)
  })

  void test('without a max wait the window is fixed: it runs delayMs after the first trigger', async () => {
    let runs = 0
    const refresh = createCoalescedRefresh({
      delayMs: 40,
      run: async () => {
        runs += 1
      },
    })

    refresh.schedule()
    await sleep(25)
    // 窗口里的新触发并进这一次，不把它往后推。
    refresh.schedule()
    await sleep(30)
    assert.equal(runs, 1)
  })

  void test('with a max wait it debounces, but still runs on the max-wait cadence while triggers never pause', async () => {
    let runs = 0
    const refresh = createCoalescedRefresh({
      delayMs: 30,
      maxDelayMs: 60,
      run: async () => {
        runs += 1
      },
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < 200) {
      refresh.schedule()
      await sleep(5)
    }
    assert.ok(runs >= 2 && runs <= 4, `expected the max-wait cadence, got ${runs}`)

    // 平时是尾沿防抖：一次触发之后安静 delayMs 才跑。
    await sleep(100)
    const before = runs
    refresh.schedule()
    await sleep(15)
    assert.equal(runs, before)
    await sleep(40)
    assert.equal(runs, before + 1)
  })

  void test('never overlaps a running refresh and catches up once after it finishes', async () => {
    let runs = 0
    let concurrent = 0
    let maxConcurrent = 0
    const refresh = createCoalescedRefresh({
      delayMs: 10,
      run: async () => {
        runs += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await sleep(40)
        concurrent -= 1
      },
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
    const refresh = createCoalescedRefresh({
      delayMs: 20,
      run: async () => {
        runs += 1
      },
    })

    refresh.schedule()
    refresh.cancel()
    await sleep(40)
    assert.equal(runs, 0)
  })

  void test('the refresh window stays inside 500–800ms', () => {
    assert.ok(WorkbenchGitWorkspaceChangeRefreshDelayMs >= 500)
    assert.ok(WorkbenchGitWorkspaceChangeRefreshDelayMs <= 800)
    // Git 界面没开时文件树颜色的节奏：慢一些，但几秒之内跟上。
    assert.ok(WorkbenchGitTreeDecorationRefreshDelayMs > WorkbenchGitWorkspaceChangeRefreshDelayMs)
    assert.ok(WorkbenchGitTreeDecorationRefreshDelayMs <= 5_000)
  })

  void test('tree Git colours follow workspace changes with the Git surfaces closed', async () => {
    const calls: string[] = []
    let surfaceActive = false
    const refresh = createWorkbenchGitWorkspaceChangeRefresh({
      refreshLineStats: async () => {
        calls.push('line-stats')
      },
      refreshSummary: async () => {
        calls.push('summary')
      },
      isGitSurfaceActive: () => surfaceActive,
      lineStatsDelayMs: 10,
      treeDecorationDelayMs: 150,
    })
    const waitForCalls = async (count: number): Promise<void> => {
      for (let waited = 0; calls.length < count; waited += 5) {
        assert.ok(waited < 2_000, `timed out waiting for ${count} refreshes: ${calls.join(', ')}`)
        await sleep(5)
      }
    }

    // Git 界面没开：顶栏 +/- 先跟，完整快照（文件树的颜色）放慢之后也跟，一串改动只刷一次。
    refresh.schedule()
    refresh.schedule()
    await waitForCalls(1)
    assert.deepEqual(calls, ['line-stats'])
    await waitForCalls(2)
    assert.deepEqual(calls, ['line-stats', 'summary'])

    // Git 界面开着：完整快照与顶栏同一节奏，不再多排一次慢的。
    calls.length = 0
    surfaceActive = true
    refresh.schedule()
    await waitForCalls(2)
    assert.deepEqual([...calls].sort(), ['line-stats', 'summary'])
    await sleep(200)
    assert.equal(calls.length, 2)

    // 撤掉之后两种节奏都不再跑。
    calls.length = 0
    surfaceActive = false
    refresh.schedule()
    refresh.cancel()
    await sleep(200)
    assert.deepEqual(calls, [])
  })

  void test('Git state owns the refresh triggers; the fetch hooks carry no dead options or parameters', () => {
    const gitState = readSource('src/renderer/src/hooks/useWorkbenchGitState.ts')
    const summaries = readSource('src/renderer/src/support/useWorkspaceGitSummaries.ts')
    const lineStats = readSource('src/renderer/src/support/useWorkspaceGitLineStats.ts')

    assert.match(gitState, /useWorkspaceFilesChangedRefresh\(\{[\s\S]*?onChanged: workspaceChangeRefresh\.schedule/u)
    // Agent 写入（主 Agent 与子 Agent）走共用的识别器，按项目根订阅。
    assert.match(
      gitState,
      /subscribeWorkbenchAgentProjectWrites\(workspaceRoot, workspaceChangeRefresh\.schedule\)/u
    )
    // 顶栏 +/- 与完整快照都跟工作区改动；Git 界面没开时完整快照放慢（文件树的 Git 颜色靠它）。
    assert.match(gitState, /createWorkbenchGitWorkspaceChangeRefresh\(\{/u)
    assert.match(gitState, /refreshLineStats: \(\) => refreshLineStatsLatest\.current\(\),/u)
    assert.match(gitState, /refreshSummary: \(\) => refreshSummaryLatest\.current\(\),/u)
    assert.match(gitState, /isGitSurfaceActive: \(\) => gitSurfacesActiveLatest\.current,/u)
    // 项目绑定好就拉完整快照，不等 Git 界面打开。
    assert.match(
      gitState,
      /void refreshLineStatsLatest\.current\(\)\n\s*void refreshSummaryLatest\.current\(\)/u
    )
    // Git 操作之后、手动刷新、一轮 Agent 结束共用一个 refresh，不再是三份一样的实现。
    assert.match(gitState, /await Promise\.all\(\[refreshSummary\(\), refreshLineStats\(\)\]\)/u)
    assert.doesNotMatch(gitState, /refreshAfterGitAction|refreshAfterAgentRun|refreshGitPanel/u)
    for (const source of [gitState, summaries, lineStats]) {
      assert.doesNotMatch(source, /watchFileChanges|watchSessionWorkspace|refreshKey/u)
      // 拉取不看原因、没有 force：刷新请求不带参数。
      assert.doesNotMatch(source, /RefreshReason|RefreshRequest|reason:|force:|_request/u)
    }
    for (const source of [summaries, lineStats]) {
      assert.match(source, /refresh: \(\) => Promise<void>/u)
      assert.match(source, /async \(\): Promise<void> => \{/u)
    }
  })
})
