import assert from 'node:assert/strict'

import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type { WorkbenchI18nContextValue } from '../src/renderer/src/i18n'
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
import type { WorkspaceGitBranch } from '../src/shared/contracts'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

// 翻译表那个模块会连带加载 UI 包：和组件一样，要等上面把 React 对齐之后再加载。
const { translateWorkbenchAppMessage } = await import(
  '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
)
const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n')
const { WorkbenchGitBranchMenu } = await import(
  '../src/renderer/src/components/git/WorkbenchGitBranchMenu'
)

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
    assert.deepEqual(listWorkbenchGitMenuBranches([], { branch: 'main', upstream: 'origin/main' }), [
      { name: 'main', current: true, upstream: 'origin/main', kind: 'local' },
    ])
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
        ['sync', 'Sync', false, 0],
        ['fetch', 'Fetch Remotes', false, 0],
      ]
    )
    assert.match(tracking[0]?.hint ?? '', /origin\/main/u)
    assert.equal(describeWorkbenchGitRemoteNote(onBranch, english), null)

    // 还没有上游：拉取、同步按不了（写明原因）；推送能按，会顺便关联远端分支。
    const fresh = describeWorkbenchGitRemoteActions(unpublished, english)
    assert.deepEqual(
      fresh.map((item) => item.disabled),
      [true, false, true, false]
    )
    assert.equal(fresh[0]?.hint, english('workbench.gitNoUpstreamHint'))
    assert.equal(fresh[1]?.hint, english('workbench.gitPublishHint'))
    assert.equal(describeWorkbenchGitRemoteNote(unpublished, english), english('workbench.gitNoUpstreamNote'))

    // 分离的 HEAD：只有获取远端还能用，其余说明原因（带着停在的提交）。
    const headless = describeWorkbenchGitRemoteActions(detached, chinese)
    assert.deepEqual(
      headless.map((item) => item.disabled),
      [true, true, true, false]
    )
    for (const item of headless.slice(0, 3)) assert.match(item.hint, /1a2b3c4/u)
    assert.match(describeWorkbenchGitRemoteNote(detached, chinese) ?? '', /1a2b3c4/u)
  })

  void test('an operation in progress blocks everything but fetch, and says to finish it first', () => {
    const rebasing = { kind: 'rebase' as const, step: 1, total: 2, detail: 'feature' }
    assert.equal(describeWorkbenchGitOperationBlock(null, english), null)
    const block = describeWorkbenchGitOperationBlock(rebasing, english)
    assert.match(block ?? '', /^A rebase is in progress\. Continue or abort it in the commit panel/u)
    assert.match(describeWorkbenchGitOperationBlock({ kind: 'merge' }, chinese) ?? '', /^正在合并。/u)

    // 变基时 HEAD 是分离的：原因说的是变基，不是「先切到一个分支」。
    const actions = describeWorkbenchGitRemoteActions(detached, english, block)
    assert.deepEqual(
      actions.map((item) => item.disabled),
      [true, true, true, false]
    )
    for (const item of actions.slice(0, 3)) assert.equal(item.hint, block)
    assert.equal(describeWorkbenchGitRemoteNote(detached, english, block), block)
    // 在分支上合并到一半也一样：有上游也不给拉取、推送。
    assert.deepEqual(
      describeWorkbenchGitRemoteActions(onBranch, english, block).map((item) => item.disabled),
      [true, true, true, false]
    )
    assert.equal(describeWorkbenchGitRemoteNote(onBranch, english, block), block)
  })

  void test('the button names the branch being rebased instead of a detached HEAD', () => {
    const rebasing = { kind: 'rebase' as const, detail: 'feature/login' }
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, rebasing, english),
      'feature/login (rebasing)'
    )
    assert.equal(describeWorkbenchGitBranchControlHead(detached, rebasing, chinese), 'feature/login（变基中）')
    // 读不出是哪个分支、或者不是变基：照旧。
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, { kind: 'rebase', detail: null }, english),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(
      describeWorkbenchGitBranchControlHead(detached, { kind: 'cherry-pick', detail: 'abc1234' }, english),
      'Detached HEAD · 1a2b3c4'
    )
    assert.equal(describeWorkbenchGitBranchControlHead(detached, null, english), 'Detached HEAD · 1a2b3c4')
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
      search: '',
      searchRef: createRef<HTMLInputElement>(),
      remoteActions: describeWorkbenchGitRemoteActions(onBranch, english),
      remoteNote: null,
      running: null,
      switchingBranch: null,
      locked: false,
      branchesBlocked: null,
      onSearchChange: noop,
      onRunRemoteAction: noop,
      onCancelRemoteAction: noop,
      onSwitchBranch: noop,
      onPushBranch: noop,
      onOpenCreateBranch: noop,
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
      label: (match[2] ?? '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim(),
      tag: match[1] ?? '',
    }))
  }

  void test('the four remote actions come first, with the commit counts on pull and push', () => {
    const all = buttons(render())
    assert.deepEqual(
      all.slice(0, 4).map((button) => button.label),
      ['Pull 3', 'Push 2', 'Sync', 'Fetch Remotes']
    )
    for (const button of all.slice(0, 4)) {
      assert.doesNotMatch(button.tag, /aria-disabled|\bdisabled\b/u)
      assert.match(button.tag, /title="[^"]+"/u)
    }
    // 最后一项是新建分支。
    assert.equal(all.at(-1)?.label, 'New branch')
  })

  void test('an action that cannot run stays reachable and says why', () => {
    const markup = render({
      remoteActions: describeWorkbenchGitRemoteActions(unpublished, english),
      remoteNote: describeWorkbenchGitRemoteNote(unpublished, english),
    })
    const [pull, push] = buttons(markup)
    // 用 aria-disabled 而不是 disabled：焦点、悬停说明照常。
    assert.match(pull?.tag ?? '', /aria-disabled="true"/u)
    assert.doesNotMatch(pull?.tag ?? '', /\sdisabled(=|\s|$)/u)
    assert.ok(pull?.tag.includes(`title="${english('workbench.gitNoUpstreamHint')}"`))
    assert.doesNotMatch(push?.tag ?? '', /aria-disabled/u)
    assert.ok(markup.includes(english('workbench.gitNoUpstreamNote')))
  })

  void test('while a remote action runs the actions give way to its progress and a cancel button', () => {
    const operation = { id: 'op', workspaceRoot: '/p', action: 'pull' as const, cancelling: false }
    const running = render({ running: operation, locked: true })
    assert.match(running, /role="status"[^>]*>[\s\S]*Pull in progress…/u)
    const all = buttons(running)
    assert.equal(all[0]?.label, 'Cancel')
    assert.doesNotMatch(all[0]?.tag ?? '', /\sdisabled(=|\s|$)/u)
    // 四个操作不在了（行里悬停才出的「推送」还在，但按不了）。
    assert.doesNotMatch(running, /data-action=/u)
    // 跑着的时候不切分支、不新建分支。
    assert.match(all.at(-1)?.tag ?? '', /\sdisabled=""/u)
    for (const button of all.filter((entry) => /data-git-menu-item/u.test(entry.tag)).slice(1))
      if (!/aria-expanded/u.test(button.tag)) assert.match(button.tag, /\sdisabled=""/u)

    const cancelling = buttons(render({ running: { ...operation, cancelling: true }, locked: true }))
    assert.equal(cancelling[0]?.label, 'Cancelling…')
    assert.match(cancelling[0]?.tag ?? '', /\sdisabled=""/u)
  })

  void test('the current branch is marked, shows what it tracks, and cannot be checked out again', () => {
    const markup = render()
    const current = /<div[^>]*data-current="true"[^>]*title="main">([\s\S]*?)<\/div>/u.exec(markup)
    assert.ok(current, 'no current row')
    assert.match(current[1] ?? '', /<button[^>]*aria-current="true"[^>]*disabled=""/u)
    assert.match(current[1] ?? '', /<small>origin\/main<\/small>/u)
    assert.equal(markup.match(/data-current="true"/gu)?.length, 1)
    // 别的本地分支：悬停出「签出」「推送」；远端分支只有「签出」。
    assert.match(markup, /aria-label="Check out docs"/u)
    assert.match(markup, /aria-label="Push docs"/u)
    assert.match(markup, /aria-label="Check out origin\/main"/u)
    assert.doesNotMatch(markup, /aria-label="Push origin\/main"/u)
    assert.doesNotMatch(markup, /aria-label="(?:Check out|Push) main"/u)
    // 分离的 HEAD 上没有哪一行算当前的。
    assert.doesNotMatch(
      render({
        currentBranch: null,
        branches: branches.map((branch) => ({ ...branch, current: false })),
      }),
      /data-current/u
    )
  })

  void test('with an operation in progress branches cannot be switched or created, fetch still works', () => {
    const block = describeWorkbenchGitOperationBlock({ kind: 'merge' }, english)
    const markup = render({
      remoteActions: describeWorkbenchGitRemoteActions(onBranch, english, block),
      remoteNote: block,
      branchesBlocked: block,
    })
    const all = buttons(markup)
    // 四个远端操作都在（没有在跑的远端操作），只有获取远端能按。
    assert.deepEqual(
      all.slice(0, 4).map((button) => /aria-disabled="true"/u.test(button.tag)),
      [true, true, true, false]
    )
    assert.ok(markup.includes('A merge is in progress.'))
    // 别的分支点不了，原因写在那一行的悬停说明里；新建分支也点不了。
    const docs = /<div[^>]*title="([^"]*)"[^>]*>\s*<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*docs/u.exec(
      markup
    )
    assert.ok(docs, 'the docs row should be disabled')
    assert.match(docs[1] ?? '', /^A merge is in progress\./u)
    assert.match(all.at(-1)?.tag ?? '', /\sdisabled=""/u)
    assert.equal(all.at(-1)?.label, 'New branch')
  })

  void test('a search that matches nothing says so instead of showing an empty list', () => {
    const markup = render({ search: 'nothing-like-this' })
    assert.ok(markup.includes(english('workbench.gitBranchNoMatch')))
    assert.doesNotMatch(markup, /title="main"/u)
    // 搜到的分支不藏在目录里：目录一律展开。
    const found = render({ search: 'login' })
    assert.match(found, /aria-expanded="true"[\s\S]*title="feature\/login"/u)
    assert.doesNotMatch(found, /title="docs"/u)
  })
})
