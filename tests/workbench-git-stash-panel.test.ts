import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import type { WorkbenchI18nContextValue } from '../src/renderer/src/i18n'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  getWorkbenchGitStashSubtitle,
  getWorkbenchGitStashTitle,
  isSameWorkbenchGitStashList,
  shouldWorkbenchGitStashIncludeUntrackedByDefault,
} from '../src/renderer/src/models/git/workbenchGitStashModel'
import type { WorkspaceGitStash } from '../src/shared/contracts'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

const english: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('en-US', key, params)
const chinese: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('zh-CN', key, params)

function stash(overrides: Partial<WorkspaceGitStash> = {}): WorkspaceGitStash {
  return {
    sha: 'a'.repeat(40),
    index: 0,
    message: 'login page, half done',
    autoMessage: false,
    branch: 'main',
    createdAt: 0,
    includesUntracked: false,
    ...overrides,
  }
}

void describe('Workbench Git stash presentation', () => {
  void test('a stash is shown by its message, or as untitled with the commit it sits on', () => {
    assert.equal(getWorkbenchGitStashTitle(stash(), english), 'login page, half done')
    assert.equal(getWorkbenchGitStashSubtitle(stash(), english), 'Stashed on main')

    const untitled = stash({ autoMessage: true, message: '1a2b3c4 add login' })
    assert.equal(getWorkbenchGitStashTitle(untitled, english), 'Untitled stash')
    assert.equal(getWorkbenchGitStashTitle(untitled, chinese), '未命名的贮藏')
    assert.equal(
      getWorkbenchGitStashSubtitle(untitled, english),
      'Stashed on main · based on 1a2b3c4 add login'
    )
    assert.equal(
      getWorkbenchGitStashSubtitle(stash({ branch: null }), chinese),
      '贮藏于分离的 HEAD'
    )
  })

  void test('the list only re-renders when the stashes or their order changed', () => {
    const first = stash({ sha: 'a'.repeat(40), index: 0 })
    const second = stash({ sha: 'b'.repeat(40), index: 1 })
    assert.equal(isSameWorkbenchGitStashList([first, second], [{ ...first }, { ...second }]), true)
    assert.equal(isSameWorkbenchGitStashList([first, second], [first]), false)
    assert.equal(
      isSameWorkbenchGitStashList([first, second], [
        { ...second, index: 0 },
        { ...first, index: 1 },
      ]),
      false
    )
  })

  void test('untracked files are only taken along by default when nothing else can be stashed', () => {
    assert.equal(shouldWorkbenchGitStashIncludeUntrackedByDefault({ tracked: 2, untracked: 3 }), false)
    assert.equal(shouldWorkbenchGitStashIncludeUntrackedByDefault({ tracked: 0, untracked: 3 }), true)
    assert.equal(shouldWorkbenchGitStashIncludeUntrackedByDefault({ tracked: 0, untracked: 0 }), false)
  })

  void test('stashing is reachable from the commit panel, the stashes from the Git tool window', () => {
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const toolPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')
    const refsPane = readSource('src/renderer/src/components/git/WorkbenchGitRefsPane.tsx')
    const details = readSource('src/renderer/src/components/git/WorkbenchGitDetailsPane.tsx')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')

    // 提交面板：贮藏按钮开对话框，贮藏完能一步跳到贮藏列表。
    assert.match(commitPanel, /label=\{t\('workbench\.gitStashChanges'\)\}/u)
    assert.match(commitPanel, /<WorkbenchGitStashDialog/u)
    assert.match(commitPanel, /stashWorkspaceGitChanges\(workspaceRoot, options\)/u)
    assert.match(commitPanel, /onClick: onOpenGitTool/u)
    // 贮藏读的是磁盘上的文件：有没保存的内容时先提醒。
    assert.match(commitPanel, /function requestStash\(\): void \{[\s\S]*?warnUnsavedOpenTabs\(\)/u)

    // Git 工具窗：贮藏列在分支下面，选中一条看它的改动，应用、弹出、删除。
    assert.match(refsPane, /stashes\.filter|visibleStashes\.map/u)
    assert.match(details, /stashSha: stashSha \?\? undefined/u)
    assert.match(toolPanel, /performWorkspaceGitStashAction\(/u)
    // 删除之前先问；取回会改工作区，有没保存的内容时拦下；冲突交给提交面板。
    assert.match(
      toolPanel,
      /action === 'drop' &&\s*!window\.confirm\(\s*tLatest\.current\(\s*stash\.includesUntracked\s*\? 'workbench\.gitStashDropUntrackedConfirm'\s*: 'workbench\.gitStashDropConfirm'/u
    )
    assert.match(toolPanel, /if \(action !== 'drop' && hasUnsavedOpenTabs\)/u)
    assert.match(
      toolPanel,
      /result\.stashAction\.conflicts\.length > 0[\s\S]*?onOpenCommitTool\(\)/u
    )
    assert.match(presentation, /onOpenCommitTool=\{openCommitTool\}/u)
    assert.match(presentation, /onRefresh=\{model\.actions\.refreshProjectAndGit\}/u)
  })
})
