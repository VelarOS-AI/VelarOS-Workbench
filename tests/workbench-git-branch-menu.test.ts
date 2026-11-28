import assert from 'node:assert/strict'

import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import { type WorkbenchI18nContextValue } from '../src/renderer/src/i18n/WorkbenchLocalizationProvider'
import {
  buildWorkbenchGitBranchTree,
  describeWorkbenchGitBranchControl,
  describeWorkbenchGitBranchControlHead,
  describeWorkbenchGitOperationBlock,
  describeWorkbenchGitRemoteActions,
  describeWorkbenchGitRemoteNote,
  filterWorkbenchGitBranches,
  listWorkbenchGitMenuBranches,
  resolveWorkbenchGitBranchSwitch,
  type WorkbenchGitBranchTreeNode,
} from '../src/renderer/src/models/git/workbenchGitBranchMenuModel'
import { type WorkspaceGitBranch } from '../src/shared/contracts/system'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

// 翻译表那个模块会连带加载 UI 包：和组件一样，要等上面把 React 对齐之后再加载。
const { translateWorkbenchAppMessage } =
  await import('../src/renderer/src/i18n/useStandaloneWorkbenchLocalization')
const { WorkbenchLocalizationProvider } =
  await import('../src/renderer/src/i18n/WorkbenchLocalizationProvider')
const { WorkbenchGitBranchMenu } =
  await import('../src/renderer/src/components/git/WorkbenchGitBranchMenu')

type MenuProps = Parameters<typeof WorkbenchGitBranchMenu>[0]

const english: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('en-US', key, params)
const chinese: WorkbenchI18nContextValue['t'] = (key, params) =>
  translateWorkbenchAppMessage('zh-CN', key, params)

function local(name: string, extra: Partial<WorkspaceGitBranch> = {}): WorkspaceGitBranch {
  return { name, current: false, upstream: null, kind: 'local', ...extra }
}

function remote(name: string): WorkspaceGitBranch {
  return { name, current: false, upstream: null, kind: 'remote' }
}

const branches: WorkspaceGitBranch[] = [
  local('main', { current: true, upstream: 'origin/main' }),
  local('feature/login'),
  local('feature/signup'),
  local('docs'),
  remote('origin/main'),
  remote('origin/feature/login'),
]

const onBranch = {
  branch: 'main',
  detachedHead: null,
  upstream: 'origin/main',
  ahead: 2,
  behind: 3,
}
const unpublished = { ...onBranch, upstream: null, ahead: 0, behind: 0 }
const detached = {
  branch: null,
  detachedHead: { sha: 'a'.repeat(40), shortSha: '1a2b3c4' },
  upstream: null,
  ahead: 0,
  behind: 0,
}

/** 树画成缩进的文字：目录后面带 `/`，分支后面带 `*`。 */
function outline(nodes: readonly WorkbenchGitBranchTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.segment}${node.children.length > 0 ? '/' : ''}${node.branch ? '*' : ''}`,
    ...outline(node.children, depth + 1),
  ])
}

void describe('Workbench Git branch menu model', () => {
  void test('branches are laid out as a tree by the slashes in their names', () => {
    const localBranches = branches.filter((branch) => branch.kind !== 'remote')
    assert.deepEqual(outline(buildWorkbenchGitBranchTree(localBranches, 'local')), [
      // 目录在前，各自按名字排。
      'feature/',
      '  login*',
      '  signup*',
      'docs*',
      'main*',
    ])
    const tree = buildWorkbenchGitBranchTree(
      branches.filter((branch) => branch.kind === 'remote'),
      'remote'
    )
    assert.deepEqual(outline(tree), ['origin/', '  feature/', '    login*', '  main*'])
    // 键带着命名空间：本地的 feature 和远端的 origin/feature 折叠状态互不相干。
    assert.equal(tree[0]?.key, 'remote:origin')
    assert.equal(tree[0]?.children[0]?.key, 'remote:origin/feature')
    assert.equal(tree[0]?.children[0]?.children[0]?.branch?.name, 'origin/feature/login')
  })

  void test('the search keeps the branches whose name contains it, ignoring case', () => {
    assert.deepEqual(
      filterWorkbenchGitBranches(branches, ' LOGIN ').map((branch) => branch.name),
      ['feature/login', 'origin/feature/login']
    )
    assert.equal(filterWorkbenchGitBranches(branches, '  ').length, branches.length)
    assert.deepEqual(filterWorkbenchGitBranches(branches, 'nothing'), [])
  })

  void test('before the branch list is read, the menu lists the current branch', () => {
    assert.deepEqual(
      listWorkbenchGitMenuBranches([], { branch: 'main', upstream: 'origin/main' }),
      [{ name: 'main', current: true, upstream: 'origin/main', kind: 'local' }]
    )
    assert.deepEqual(listWorkbenchGitMenuBranches([], { branch: null, upstream: null }), [])
    assert.equal(
      listWorkbenchGitMenuBranches(branches, { branch: 'main', upstream: null }).length,
      branches.length
    )
  })

  void test('a remote branch is checked out as the local branch of the same name', () => {
    assert.deepEqual(resolveWorkbenchGitBranchSwitch(local('docs'), branches), { branch: 'docs' })
    // 本地已经有 feature/login：切到它，不新建。
    assert.deepEqual(resolveWorkbenchGitBranchSwitch(remote('origin/feature/login'), branches), {
      branch: 'feature/login',
    })
    // 本地还没有：从远端分支新建同名的本地分支。
    assert.deepEqual(resolveWorkbenchGitBranchSwitch(remote('origin/release/1.0'), branches), {
      branch: 'release/1.0',
      options: { create: true, startPoint: 'origin/release/1.0' },
    })
  })

  void test('remote actions follow the upstream: counts when tracking, reasons when not', () => {
    const tracking = describeWorkbenchGitRemoteActions(onBranch, english)
    assert.deepEqual(
      tracking.map((item) => [item.action, item.label, item.disabled, item.count]),
      [
        ['pull', 'Pull', false, 3],
        ['upload', 'Push', false, 2],
        ['fetch', 'Fetch Remotes', false, 0],
        ['sync', 'Sync', false, 0],
      ]
    )
    assert.match(tracking[0]?.hint ?? '', /origin\/main/u)
    assert.equal(describeWorkbenchGitRemoteNote(onBranch, english), null)

    // 还没有上游：拉取按不了（写明原因）；推送能按，会顺便关联远端分支。
    const fresh = describeWorkbenchGitRemoteActions(unpublished, english)
    assert.deepEqual(
      fresh.map((item) => item.disabled),
      [true, false, false, true]
    )
    assert.equal(fresh[0]?.hint, english('workbench.gitNoUpstreamHint'))
    assert.equal(fresh[1]?.hint, english('workbench.gitPublishHint'))
    assert.equal(
      describeWorkbenchGitRemoteNote(unpublished, english),
      english('workbench.gitNoUpstreamNote')
    )

    // 分离的 HEAD：只有获取远端还能用，其余说明原因（带着停在的提交）。
    const headless = describeWorkbenchGitRemoteActions(detached, chinese)
    assert.deepEqual(
      headless.map((item) => item.disabled),
      [true, true, false, true]
    )
    for (const item of headless.slice(0, 2)) assert.match(item.hint, /1a2b3c4/u)
    assert.match(describeWorkbenchGitRemoteNote(detached, chinese) ?? '', /1a2b3c4/u)
  })

  void test('an operation in progress blocks everything but fetch, and says to finish it first', () => {
    const rebasing = { kind: 'rebase' as const, step: 1, total: 2, detail: 'feature' }
    assert.equal(describeWorkbenchGitOperationBlock(null, english), null)
    const block = describeWorkbenchGitOperationBlock(rebasing, english)
    assert.match(
      block ?? '',
      /^A rebase is in progress\. Continue or abort it in the commit panel/u
    )
    assert.match(
      describeWorkbenchGitOperationBlock({ kind: 'merge' }, chinese) ?? '',
      /^正在合并。/u
    )

    // 变基时 HEAD 是分离的：原因说的是变基，不是「先切到一个分支」。
    const actions = describeWorkbenchGitRemoteActions(detached, english, block)
    assert.deepEqual(
      actions.map((item) => item.disabled),
      [true, true, false, true]
    )
    for (const item of actions.slice(0, 2)) assert.equal(item.hint, block)
    assert.equal(describeWorkbenchGitRemoteNote(detached, english, block), block)
    // 在分支上合并到一半也一样：有上游也不给拉取、推送。
    assert.deepEqual(
      describeWorkbenchGitRemoteActions(onBranch, english, block).map((item) => item.disabled),
      [true, true, false, true]
    )
    assert.equal(describeWorkbenchGitRemoteNote(onBranch, english, block), block)
  })

  void test('the button names the branch being rebased instead of a detached HEAD', () => {
    const rebasing = { kind: 'rebase' as const, detail: 'feature/login' }
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, rebasing, english),
      'feature/login (rebasing)'
    )
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, rebasing, chinese),
      'feature/login（变基中）'
    )
    // 读不出是哪个分支、或者不是变基：照旧。
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, { kind: 'rebase', detail: null }, english),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitBranchControlHead(
        detached,
        { kind: 'cherry-pick', detail: 'abc1234' },
        english
      ),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, null, english),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitBranchControlHead(
        { branch: 'main', detachedHead: null },
        { kind: 'merge', detail: "Merge branch 'feature'" },
        english
      ),
      'main'
    )
  })

  void test('the toolbar button says whether there are changes and how far the upstream is', () => {
    const clean = { ...onBranch, isClean: true, changedFiles: 0 }
    assert.equal(
      describeWorkbenchGitBranchControl(clean, english),
      'Working tree clean · origin/main: 3 behind, 2 ahead'
    )
    assert.equal(
      describeWorkbenchGitBranchControl({ ...clean, isClean: false, changedFiles: 4 }, english),
      '4 changed files · origin/main: 3 behind, 2 ahead'
    )
    assert.equal(
      describeWorkbenchGitBranchControl({ ...clean, upstream: null }, english),
      `Working tree clean · ${english('workbench.gitNoUpstreamHint')}`
    )
    // 分离的 HEAD：没有上游可说。
    assert.equal(
      describeWorkbenchGitBranchControl({ ...clean, branch: null, upstream: null }, english),
      'Working tree clean'
    )
  })
})

void describe('Workbench Git branch menu', () => {
  const noop = (): void => undefined

  function render(props: Partial<MenuProps> = {}): string {
    const menu = createElement(WorkbenchGitBranchMenu, {
      branches,
      currentBranch: 'main',
      selectedBranch: null,
      search: '',
      searchRef: createRef<HTMLInputElement>(),
      remoteActions: describeWorkbenchGitRemoteActions(onBranch, english),
      remoteNote: null,
      running: null,
      switchingBranch: null,
      locked: false,
      branchesBlocked: null,
      canIntegrate: true,
      onSearchChange: noop,
      onSelectBranch: noop,
      onRunRemoteAction: noop,
      onCancelRemoteAction: noop,
      onSwitchBranch: noop,
      onPushBranch: noop,
      onRunBranchOperation: noop,
      onOpenCreateBranch: noop,
      onOpenRenameBranch: noop,
      onDeleteBranch: noop,
      onCopyBranch: noop,
      onInspectBranch: noop,
      ...props,
    })
    return renderToStaticMarkup(
      createElement(WorkbenchLocalizationProvider, {
        value: { locale: 'en-US', setLocale: async () => undefined, t: english },
        children: menu,
      })
    )
  }

  /** 菜单里每个按钮：文字，和它的那一段开标签。 */
  function buttons(markup: string): Array<{ label: string; tag: string }> {
    return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].map((match) => ({
      label: (match[2] ?? '')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
      tag: match[1] ?? '',
    }))
  }

  void test('fetch stays beside search and current branch actions appear in the selected details', () => {
    assert.doesNotMatch(render(), /data-action="(?:pull|upload)"/u)
    const markup = render({ selectedBranch: local('main') })
    const all = buttons(markup)
    const actions = all.filter((button) => /data-action=/u.test(button.tag))
    assert.equal(actions.length, 4)
    assert.ok(markup.indexOf('<input') < markup.indexOf('data-action='))
    assert.deepEqual(
      actions.map((button) => button.label),
      ['', 'Pull', 'Push', 'Sync']
    )
    assert.deepEqual(
      actions.map((button) => /aria-label="([^"]+)"/u.exec(button.tag)?.[1]),
      ['Fetch Remotes', 'Pull', 'Push', 'Sync']
    )
    const searchActions = buttons(markup.slice(0, markup.indexOf('Local branches'))).filter(
      (button) => /data-action=/u.test(button.tag)
    )
    assert.equal(searchActions.length, 1)
    assert.match(searchActions[0]?.tag ?? '', /data-action="fetch"/u)
    const details = markup.slice(markup.lastIndexOf('<section'))
    assert.deepEqual(
      buttons(details).map((button) => button.label),
      [
        'New branch from here',
        'Pull',
        'Push',
        'Sync',
        'View commit history',
        'Copy branch name',
        'Rename branch',
      ]
    )
    for (const button of actions) {
      assert.doesNotMatch(button.tag, /aria-disabled|\bdisabled\b/u)
      assert.match(button.tag, /aria-description="[^"]+"/u)
    }
    assert.ok(all.some((button) => button.label === 'New branch'))
  })

  void test('an unavailable action remains focusable and explains its state to assistive technology', () => {
    const markup = render({
      selectedBranch: local('main'),
      remoteActions: describeWorkbenchGitRemoteActions(unpublished, english),
      remoteNote: describeWorkbenchGitRemoteNote(unpublished, english),
    })
    const all = buttons(markup)
    const pull = all.find((button) => /data-action="pull"/u.test(button.tag))
    const push = all.find((button) => /data-action="upload"/u.test(button.tag))
    assert.match(pull?.tag ?? '', /aria-disabled="true"/u)
    assert.doesNotMatch(pull?.tag ?? '', /\sdisabled(=|\s|$)/u)
    assert.ok(pull?.tag.includes(english('workbench.gitNoUpstreamHint')))
    assert.doesNotMatch(push?.tag ?? '', /aria-disabled/u)
    assert.ok(markup.includes(english('workbench.gitNoUpstreamNote')))
  })

  void test('remote actions show progress and cancellation on the corresponding existing button', () => {
    for (const [action, slot, branch, selectedBranch] of [
      ['pull', 'pull', undefined, local('main')],
      ['upload', 'upload', undefined, local('main')],
      ['fetch', 'fetch', undefined, local('main')],
      ['sync', 'sync', undefined, local('main')],
      ['sync', 'fetch', undefined, null],
      ['upload', 'upload', 'docs', local('docs')],
      ['upload', 'fetch', 'docs', local('main')],
      ['pull', 'fetch', undefined, null],
    ] as const) {
      const operation = { id: 'op', workspaceRoot: '/p', action, cancelling: false, branch }
      const running = render({ running: operation, locked: true, selectedBranch })
      assert.doesNotMatch(running, /role="status"/u)
      const all = buttons(running)
      const active = all.filter((button) => /data-running="true"/u.test(button.tag))
      assert.equal(active.length, 1)
      const cancel = active[0]!
      assert.ok(cancel.tag.includes(`data-action="${slot}"`))
      assert.match(cancel.tag, /aria-label="Cancel [^"]+"/u)
      assert.match(cancel.tag, /aria-description="[^"]+ in progress…"/u)
      assert.doesNotMatch(cancel.tag, /\sdisabled(=|\s|$)/u)
      assert.match(all.find((button) => button.label === 'New branch')?.tag ?? '', /\sdisabled=""/u)
      for (const button of all.filter((entry) => /data-action=/u.test(entry.tag))) {
        if (button !== cancel) assert.match(button.tag, /aria-disabled="true"/u)
      }
      const cancelling = buttons(
        render({ running: { ...operation, cancelling: true }, locked: true, selectedBranch })
      ).find((button) => /data-running="true"/u.test(button.tag))
      assert.match(cancelling?.tag ?? '', /aria-label="Cancelling…"[\s\S]*\sdisabled=""/u)
    }
  })

  void test('the current branch remains selectable and shows what it tracks', () => {
    const markup = render({ selectedBranch: local('main') })
    const current = /<div[^>]*data-current="true"[^>]*title="main">([\s\S]*?)<\/div>/u.exec(markup)
    assert.ok(current, 'no current row')
    assert.match(
      current[1] ?? '',
      /<button[^>]*aria-current="true"[^>]*aria-expanded="true"[^>]*aria-controls="[^"]+"/u
    )
    assert.doesNotMatch(current[1] ?? '', /\sdisabled=""/u)
    assert.match(current[1] ?? '', /<small>origin\/main<\/small>/u)
    assert.equal(markup.match(/data-current="true"/gu)?.length, 1)
    // 分离的 HEAD 上没有哪一行算当前的。
    assert.doesNotMatch(
      render({
        currentBranch: null,
        branches: branches.map((branch) => ({ ...branch, current: false })),
      }),
      /data-current/u
    )
  })

  void test('other local and remote branches expose the actions applicable to each', () => {
    for (const selectedBranch of [local('docs'), remote('origin/main')]) {
      const markup = render({ selectedBranch })
      const details = markup.slice(markup.lastIndexOf('<section'))
      const actions = buttons(details).map((button) => button.label)
      assert.deepEqual(actions, [
        english('workbench.gitBranchCheckoutCreated'),
        english('workbench.gitBranchCreateFromSelected'),
        ...(selectedBranch.kind === 'local' ? [english('workbench.gitUpload')] : []),
        english('workbench.gitMergeIntoCurrent'),
        english('workbench.gitRebaseCurrentOnto'),
        english('workbench.gitBranchShowLog'),
        english('workbench.gitBranchCompare'),
        english('workbench.gitBranchCopyName'),
        ...(selectedBranch.kind === 'local'
          ? [english('workbench.gitBranchRename'), english('workbench.gitBranchDelete')]
          : []),
      ])
    }
  })

  void test('a named local branch can be pushed from detached HEAD', () => {
    const all = buttons(
      render({
        currentBranch: null,
        selectedBranch: local('docs'),
        canIntegrate: false,
        remoteActions: describeWorkbenchGitRemoteActions(detached, english),
      })
    )
    const push = all.find((button) => /data-action="upload"/u.test(button.tag))
    assert.match(push?.tag ?? '', /aria-label="Push docs"/u)
    assert.doesNotMatch(push?.tag ?? '', /aria-disabled/u)
  })

  void test('with an operation in progress branches cannot be switched or created, fetch still works', () => {
    const block = describeWorkbenchGitOperationBlock({ kind: 'merge' }, english)
    const markup = render({
      remoteActions: describeWorkbenchGitRemoteActions(onBranch, english, block),
      selectedBranch: local('main'),
      remoteNote: block,
      branchesBlocked: block,
    })
    const all = buttons(markup)
    // 获取远端可用，当前分支的拉取与推送说明阻塞原因。
    assert.deepEqual(
      all
        .filter((button) => /data-action=/u.test(button.tag))
        .map((button) => /aria-disabled="true"/u.test(button.tag)),
      [false, true, true, true]
    )
    assert.ok(markup.includes('A merge is in progress.'))
    for (const button of all.filter((button) => button.label.startsWith('New branch'))) {
      assert.match(button.tag, /\sdisabled=""/u)
      assert.match(button.tag, /title="A merge is in progress\./u)
    }
  })

  void test('a search that matches nothing says so instead of showing an empty list', () => {
    const markup = render({ search: 'nothing-like-this', selectedBranch: local('main') })
    assert.ok(markup.includes(english('workbench.gitBranchNoMatch')))
    assert.doesNotMatch(markup, /title="main"/u)
    // 搜到的分支不藏在目录里：目录一律展开。
    const found = render({ search: 'login' })
    assert.match(found, /aria-expanded="true"[\s\S]*title="feature\/login"/u)
    assert.doesNotMatch(found, /title="docs"/u)
  })
})
