import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import { type WorkbenchI18nContextValue } from '../src/renderer/src/i18n/WorkbenchLocalizationProvider'
import {
  beginWorkbenchGitOperation,
  buildWorkbenchGitOperationConfirm,
  describeWorkbenchGitOperationBanner,
  describeWorkbenchGitOperationOutcome,
  endWorkbenchGitOperation,
  readWorkbenchGitPendingOperation,
  resolveWorkbenchGitListedBranch,
  resolveWorkbenchGitRefBranch,
  subscribeWorkbenchGitPendingOperations,
  toWorkspaceGitOperationRequest,
  type WorkbenchGitOperationIntent,
} from '../src/renderer/src/models/git/workbenchGitOperationModel'
import { type SystemWorkspaceGitOperationResult } from '../src/shared/contracts/system'
import { type WorkspaceGitOperationState } from '../src/shared/contracts/workspaceGit'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n/WorkbenchLocalizationProvider')
const { WorkbenchGitOperationBanner } = await import(
  '../src/renderer/src/components/git/WorkbenchGitOperationBanner'
)

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

const english: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('en-US', key, params)
const chinese: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('zh-CN', key, params)

const feature = { name: 'feature/login', revision: 'refs/heads/feature/login' }
const commit = { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'Fix the login form' }

function outcome(
  operation: Partial<SystemWorkspaceGitOperationResult['operation']>,
  inProgress: Nullable<WorkspaceGitOperationState> = null
): Pick<SystemWorkspaceGitOperationResult, 'operation' | 'summary'> {
  return {
    operation: { action: 'merge', conflicts: [], upToDate: false, output: '', ...operation },
    summary: {
      rootPath: '/p',
      repository: true,
      checkedAt: 0,
      status: null,
      branches: [],
      lineStats: { additions: 0, deletions: 0, changedFiles: 0, binaryFiles: 0 },
      operation: inProgress,
    },
  }
}

const rebaseStopped: WorkspaceGitOperationState = {
  kind: 'rebase',
  step: 2,
  total: 5,
  detail: 'feature/login',
}

void describe('Workbench Git operation requests', () => {
  void test('a branch is handed to git by a name that cannot be mistaken for a tag', () => {
    // 日志里的标签：名字是截出来的，拼回完整的引用名。
    assert.deepEqual(resolveWorkbenchGitRefBranch({ kind: 'branch', name: 'feature/login' }), feature)
    assert.deepEqual(resolveWorkbenchGitRefBranch({ kind: 'remote', name: 'origin/main' }), {
      name: 'origin/main',
      revision: 'refs/remotes/origin/main',
    })
    assert.equal(resolveWorkbenchGitRefBranch({ kind: 'tag', name: 'v1.0' }), null)
    assert.equal(resolveWorkbenchGitRefBranch({ kind: 'head', name: 'HEAD' }), null)
    // 分支列表里的名字是 git 自己给的最短而不含糊的写法。
    assert.deepEqual(resolveWorkbenchGitListedBranch({ name: 'heads/feature' }), {
      name: 'heads/feature',
      revision: 'heads/feature',
    })

    assert.deepEqual(toWorkspaceGitOperationRequest({ action: 'merge', branch: feature }), {
      action: 'merge',
      target: 'refs/heads/feature/login',
    })
    assert.deepEqual(toWorkspaceGitOperationRequest({ action: 'revert', commit }), {
      action: 'revert',
      target: commit.sha,
    })
    assert.deepEqual(toWorkspaceGitOperationRequest({ action: 'abort' }), { action: 'abort' })
  })

  void test('starting an operation, aborting and skipping ask first; continuing does not', () => {
    const context = { current: 'main', kind: 'merge' as const }
    assert.equal(
      buildWorkbenchGitOperationConfirm({ action: 'merge', branch: feature }, context, english),
      'Merge feature/login into main?'
    )
    assert.equal(
      buildWorkbenchGitOperationConfirm({ action: 'merge', branch: feature }, context, chinese),
      '把 feature/login 合并到 main？'
    )
    assert.match(
      buildWorkbenchGitOperationConfirm({ action: 'rebase', branch: feature }, context, english) ??
        '',
      /^Rebase main onto feature\/login\?.*already pushed/u
    )
    assert.match(
      buildWorkbenchGitOperationConfirm({ action: 'rebase', branch: feature }, context, chinese) ??
        '',
      /^把 main 变基到 feature\/login 上？.*已经推送过的提交不要变基/u
    )
    assert.equal(
      buildWorkbenchGitOperationConfirm({ action: 'cherry-pick', commit }, context, english),
      'Cherry-pick commit ccccccc “Fix the login form” onto main?'
    )
    assert.equal(
      buildWorkbenchGitOperationConfirm({ action: 'revert', commit }, context, chinese),
      '在 main 上新增一个提交，撤销提交 ccccccc“Fix the login form”的改动？'
    )
    // 提交说明太长时截断。
    const long = buildWorkbenchGitOperationConfirm(
      { action: 'cherry-pick', commit: { ...commit, subject: 'x'.repeat(200) } },
      context,
      english
    )
    assert.ok(long && long.length < 140 && long.includes('…'))

    assert.match(
      buildWorkbenchGitOperationConfirm({ action: 'abort' }, { current: 'main', kind: 'rebase' }, english) ??
        '',
      /^Abort the rebase\?.*Untracked files are left alone\.$/u
    )
    assert.match(
      buildWorkbenchGitOperationConfirm({ action: 'abort' }, context, chinese) ?? '',
      /^放弃这次合并？.*未跟踪的文件不受影响。$/u
    )
    assert.match(
      buildWorkbenchGitOperationConfirm({ action: 'skip' }, context, english) ?? '',
      /^Skip this commit\?/u
    )
    assert.equal(buildWorkbenchGitOperationConfirm({ action: 'continue' }, context, english), null)
  })
})

void describe('Workbench Git operation notices', () => {
  const merge: WorkbenchGitOperationIntent = { action: 'merge', branch: feature }
  const context = { current: 'main', kind: 'merge' as const }

  void test('a finished step says what happened, in the interface language', () => {
    assert.deepEqual(describeWorkbenchGitOperationOutcome(merge, outcome({}), context, english), {
      tone: 'success',
      title: 'Merged',
      description: 'feature/login is merged into main.',
      conflicts: false,
    })
    assert.deepEqual(describeWorkbenchGitOperationOutcome(merge, outcome({}), context, chinese), {
      tone: 'success',
      title: '已合并',
      description: 'feature/login 已合并到 main。',
      conflicts: false,
    })
    assert.deepEqual(
      describeWorkbenchGitOperationOutcome(
        { action: 'rebase', branch: feature },
        outcome({ upToDate: true }),
        { current: 'main', kind: 'rebase' },
        english
      ),
      {
        tone: 'info',
        title: 'Already up to date',
        description: 'main already sits on top of feature/login; there is nothing to rebase.',
        conflicts: false,
      }
    )
    assert.deepEqual(
      describeWorkbenchGitOperationOutcome(
        { action: 'cherry-pick', commit },
        outcome({}),
        { current: 'main', kind: 'cherry-pick' },
        english
      ),
      {
        tone: 'success',
        title: 'Cherry-picked',
        description: 'A new commit on main carries the changes of ccccccc.',
        conflicts: false,
      }
    )
    // 继续把变基做完了：没有对象可说，只说做成了。
    assert.deepEqual(
      describeWorkbenchGitOperationOutcome(
        { action: 'continue' },
        outcome({}),
        { current: 'main', kind: 'rebase' },
        chinese
      ),
      { tone: 'success', title: '已变基', description: undefined, conflicts: false }
    )
  })

  void test('conflicts, aborting and skipping are told apart from success', () => {
    const stopped = describeWorkbenchGitOperationOutcome(
      merge,
      outcome({ conflicts: ['a.ts', 'b.ts'] }, { kind: 'merge', step: null, total: null, detail: null }),
      context,
      english
    )
    assert.equal(stopped.tone, 'warning')
    assert.equal(stopped.conflicts, true)
    assert.equal(stopped.title, 'The merge stopped on conflicts')
    assert.match(stopped.description ?? '', /^2 files conflict.*press Continue at the top of the panel/u)
    assert.equal(
      describeWorkbenchGitOperationOutcome(
        { action: 'continue' },
        outcome({ conflicts: ['a.ts'] }, rebaseStopped),
        { current: 'main', kind: 'rebase' },
        chinese
      ).title,
      '变基遇到冲突，停下来了'
    )

    assert.deepEqual(
      describeWorkbenchGitOperationOutcome({ action: 'abort' }, outcome({}), context, english),
      { tone: 'info', title: 'The merge was aborted', conflicts: false }
    )
    assert.deepEqual(
      describeWorkbenchGitOperationOutcome(
        { action: 'skip' },
        outcome({}),
        { current: 'main', kind: 'cherry-pick' },
        chinese
      ),
      { tone: 'success', title: '已跳过这个提交', description: '拣选已完成。', conflicts: false }
    )
    // 这一步没冲突，操作却还停着：不说做成了。
    assert.deepEqual(
      describeWorkbenchGitOperationOutcome(
        { action: 'continue' },
        outcome({}, rebaseStopped),
        { current: 'main', kind: 'rebase' },
        english
      ),
      { tone: 'info', title: 'The rebase is still in progress', conflicts: false }
    )
  })
})

void describe('Workbench Git operation banner', () => {
  void test('says which operation stopped where, and what can be done next', () => {
    assert.deepEqual(describeWorkbenchGitOperationBanner(rebaseStopped, 2, english), {
      title: 'A rebase is in progress',
      detail: 'feature/login · commit 2 of 5',
      hint: '2 files still conflict. Resolve each one and mark it as resolved, then continue.',
      canContinue: false,
      canSkip: true,
    })
    assert.deepEqual(describeWorkbenchGitOperationBanner(rebaseStopped, 0, chinese), {
      title: '正在变基',
      detail: 'feature/login · 第 2 个提交，共 5 个',
      hint: '没有冲突了，点“继续”接着变基。',
      canContinue: true,
      canSkip: true,
    })
    const merging = describeWorkbenchGitOperationBanner(
      { kind: 'merge', step: null, total: null, detail: "Merge branch 'feature'" },
      0,
      english
    )
    assert.equal(merging.title, 'A merge is in progress')
    assert.equal(merging.detail, "Merge branch 'feature'")
    // 合并只有一步，没有可跳过的。
    assert.equal(merging.canSkip, false)
    assert.equal(
      describeWorkbenchGitOperationBanner(
        { kind: 'revert', step: null, total: null, detail: '1a2b3c4' },
        0,
        chinese
      ).detail,
      '提交 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitOperationBanner(
        { kind: 'cherry-pick', step: null, total: null, detail: null },
        0,
        english
      ).detail,
      null
    )
  })

  function render(props: {
    operation: WorkspaceGitOperationState
    conflictCount: number
    pending?: 'continue' | 'abort' | 'skip'
    hasUnsavedOpenTabs?: boolean
  }): string {
    return renderToStaticMarkup(
      createElement(WorkbenchLocalizationProvider, {
        value: { locale: 'en-US', setLocale: async () => undefined, t: english },
        children: createElement(WorkbenchGitOperationBanner, {
          operation: props.operation,
          conflictCount: props.conflictCount,
          pending: props.pending ?? null,
          hasUnsavedOpenTabs: props.hasUnsavedOpenTabs ?? false,
          onAction: () => undefined,
        }),
      })
    )
  }

  function buttons(markup: string): Array<{ label: string; disabled: boolean }> {
    return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].map((match) => ({
      label: (match[2] ?? '').replace(/<[^>]+>/gu, '').trim(),
      disabled: /\bdisabled\b/u.test(match[1] ?? ''),
    }))
  }

  void test('continue waits for the conflicts; skip is offered for everything but a merge', () => {
    const conflicted = render({ operation: rebaseStopped, conflictCount: 1 })
    assert.match(conflicted, /role="status"[^>]*data-conflicts="true"/u)
    assert.match(conflicted, /A rebase is in progress/u)
    assert.deepEqual(buttons(conflicted), [
      { label: 'Continue', disabled: true },
      { label: 'Skip', disabled: false },
      { label: 'Abort', disabled: false },
    ])

    const resolved = render({
      operation: { kind: 'merge', step: null, total: null, detail: "Merge branch 'feature'" },
      conflictCount: 0,
    })
    assert.doesNotMatch(resolved, /data-conflicts/u)
    assert.deepEqual(buttons(resolved), [
      { label: 'Continue', disabled: false },
      { label: 'Abort', disabled: false },
    ])

    // 有一步在跑、或者编辑器里有没保存的内容时，三个都按不了。
    for (const markup of [
      render({ operation: rebaseStopped, conflictCount: 0, pending: 'continue' }),
      render({ operation: rebaseStopped, conflictCount: 0, hasUnsavedOpenTabs: true }),
    ])
      assert.deepEqual(
        buttons(markup).map((button) => button.disabled),
        [true, true, true]
      )
  })
})

void describe('Workbench Git operation activity', () => {
  void test('one step runs per project at a time, and every banner hears about it', () => {
    let notified = 0
    const unsubscribe = subscribeWorkbenchGitPendingOperations(() => {
      notified += 1
    })
    try {
      assert.equal(readWorkbenchGitPendingOperation('/p'), null)
      assert.equal(beginWorkbenchGitOperation('/p', 'continue'), true)
      assert.equal(beginWorkbenchGitOperation('/p', 'abort'), false)
      assert.equal(readWorkbenchGitPendingOperation('/p'), 'continue')
      // 别的项目不受影响。
      assert.equal(beginWorkbenchGitOperation('/q', 'merge'), true)
      endWorkbenchGitOperation('/p')
      endWorkbenchGitOperation('/q')
      endWorkbenchGitOperation('/q')
      assert.equal(readWorkbenchGitPendingOperation('/p'), null)
      assert.equal(notified, 4)
    } finally {
      unsubscribe()
    }
  })
})

void describe('Workbench Git operation wiring', () => {
  void test('the banner sits at the top of the commit panel and of the Git tool window', () => {
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const toolPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')
    for (const source of [commitPanel, toolPanel]) {
      assert.match(source, /\{!!operation && \(\s*<WorkbenchGitOperationBanner/u)
      assert.match(source, /const operation = summary\?\.operation \?\? null/u)
      assert.match(source, /onAction=\{\(action\) => void gitOperation\.run\(\{ action \}\)\}/u)
    }
    // 提交面板里，提示条在改动列表之前。
    assert.ok(
      commitPanel.indexOf('<WorkbenchGitOperationBanner') <
        commitPanel.indexOf('className={styles.commitListPane}')
    )
    // 变基停着时不在这里提交：按钮禁用，并写明原因。
    assert.match(commitPanel, /const rebasing = operation\?\.kind === 'rebase'/u)
    assert.match(commitPanel, /rebasing\s*\? 'workbench\.gitCommitBlockedByRebase'/u)
    // 工具窗里出了冲突要把提交面板打开。
    assert.match(
      toolPanel,
      /useWorkbenchGitOperation\(\{\s*workspaceRoot,\s*summary,\s*hasUnsavedOpenTabs,\s*onRefresh,\s*onOpenCommitTool,\s*\}\)/u
    )
  })

  void test('branches offer merge and rebase, commits offer cherry-pick and revert', () => {
    const toolPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')
    const refsPane = readSource('src/renderer/src/components/git/WorkbenchGitRefsPane.tsx')
    assert.match(toolPanel, /gitOperation\.run\(\{ action: 'merge', branch \}\)/u)
    assert.match(toolPanel, /gitOperation\.run\(\{ action: 'rebase', branch \}\)/u)
    assert.match(toolPanel, /gitOperation\.run\(\{ action: 'cherry-pick', commit \}\)/u)
    assert.match(toolPanel, /gitOperation\.run\(\{ action: 'revert', commit \}\)/u)
    // 当前分支自己没有可合并的；已经有操作停着、还有冲突、正有一步在跑时不再开始新的。
    assert.match(toolPanel, /const disabled = operationBlocked \|\| current/u)
    assert.match(
      toolPanel,
      /const operationBlocked = !!operation \|\| conflictCount > 0 \|\| !!gitOperation\.pending/u
    )
    // 左侧的分支、提交行上的分支标签、提交行本身，都接着右键菜单。
    assert.match(
      toolPanel,
      /onBranchContextMenu=\{\(branch, event\) =>\s*openBranchMenu\(resolveWorkbenchGitListedBranch\(branch\), branch\.current, event\)/u
    )
    assert.match(toolPanel, /onCommitContextMenu=\{openCommitMenu\}/u)
    assert.match(
      toolPanel,
      /const branch = resolveWorkbenchGitRefBranch\(ref\)\s*if \(branch\) openBranchMenu\(branch, !!ref\.current, event\)\s*else openCommitMenu\(commit, event\)/u
    )
    assert.match(refsPane, /onContextMenu=\{\(event\) => \{\s*event\.preventDefault\(\)\s*onContextMenu\(branch, event\)/u)
  })

  void test('a step saves nothing behind the user\'s back: it asks first and reports conflicts', () => {
    const hook = readSource('src/renderer/src/hooks/useWorkbenchGitOperation.ts')
    // 顺序：没保存的内容先拦下，再确认，然后才登记、才请求。
    const unsaved = hook.indexOf('if (hasUnsavedOpenTabs) {')
    const confirm = hook.indexOf('if (confirmation && !window.confirm(confirmation)) return')
    const begin = hook.indexOf('if (!beginWorkbenchGitOperation(workspaceRoot, intent.action)) return')
    const request = hook.indexOf('performWorkspaceGitOperation(')
    assert.ok(unsaved > 0 && unsaved < confirm && confirm < begin && begin < request)
    // 合并、变基要有当前分支；拉取、同步在跑时等它。
    assert.match(
      hook,
      /\(intent\.action === 'merge' \|\| intent\.action === 'rebase'\) && !status\.branch/u
    )
    assert.match(hook, /remote\?\.action === 'pull' \|\| remote\?\.action === 'sync'/u)
    // 做完刷新；停在冲突上时把提交面板打开；不管成败都收场。
    assert.match(hook, /await onRefresh\(\)[\s\S]*?if \(notice\.conflicts\) onOpenCommitTool\?\.\(\)/u)
    assert.match(hook, /finally \{\s*endWorkbenchGitOperation\(workspaceRoot\)/u)
  })

  void test('the request reaches the main process through one channel', () => {
    const host = readSource('src/renderer/src/host/standaloneWorkbenchHost.ts')
    const preload = readSource('src/preload/index.ts')
    assert.match(
      host,
      /performWorkspaceGitOperation: async \(workspaceRoot, request\) =>\s*toHostResult\(\s*await window\.velarosWorkbenchGit\.performOperation\(\{ workspaceRoot, \.\.\.request \}\)/u
    )
    assert.match(
      preload,
      /performOperation: \(request\) => ipcRenderer\.invoke\(WorkbenchGitChannels\.operation, request\)/u
    )
  })
})
