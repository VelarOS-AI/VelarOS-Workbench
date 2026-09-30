import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  appendWorkbenchGitLogPage,
  filterWorkbenchGitLogCommits,
  isSameWorkbenchGitLog,
  isSameWorkbenchGitLogHead,
  isWorkbenchGitHeadCommit,
  sortWorkbenchGitRefs,
} from '../src/renderer/src/models/git/changesPanel.model'
import { resolveWorkbenchGitLogWindow } from '../src/renderer/src/models/git/workbenchGitGraph'
import type { WorkspaceGitLogEntry, WorkspaceGitRef } from '../src/shared/contracts'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function commit(sha: string, refs: WorkspaceGitRef[] = []): WorkspaceGitLogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `subject of ${sha}`,
    authorName: 'Ada',
    authorEmail: null,
    authoredAt: 0,
    parents: [],
    refs,
  }
}

void describe('Workbench Git commit graph: the log behind it', () => {
  void test('a refresh keeps the pages already read while the newest page is unchanged', () => {
    const loaded = ['e', 'd', 'c', 'b', 'a'].map((sha) => commit(sha))
    // 重读来的第一页（两个提交）与已读到的开头一样：后面三页不用重读。
    assert.equal(isSameWorkbenchGitLogHead(loaded, [commit('e'), commit('d')]), true)
    // 有了新提交、或者引用挪了：要重读。
    assert.equal(isSameWorkbenchGitLogHead(loaded, [commit('f'), commit('e')]), false)
    assert.equal(
      isSameWorkbenchGitLogHead(loaded, [
        commit('e', [{ kind: 'branch', name: 'main', current: true }]),
        commit('d'),
      ]),
      false
    )
    // 已读到的还不满一页，这次读到的更多：要换上。
    assert.equal(isSameWorkbenchGitLogHead([commit('e')], [commit('e'), commit('d')]), false)
    assert.equal(isSameWorkbenchGitLog(loaded, [...loaded]), true)
    assert.equal(isSameWorkbenchGitLog(loaded, loaded.slice(0, 4)), false)
  })

  void test('the next page is appended without repeating commits that shifted into it', () => {
    const loaded = [commit('c'), commit('b')]
    assert.deepEqual(
      appendWorkbenchGitLogPage(loaded, [commit('b'), commit('a')]).map((entry) => entry.sha),
      ['c', 'b', 'a']
    )
  })

  void test('ref labels put the checked-out branch first and the search reads their names', () => {
    const refs: WorkspaceGitRef[] = [
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v2.0' },
      { kind: 'branch', name: 'release' },
      { kind: 'branch', name: 'main', current: true },
    ]
    assert.deepEqual(
      sortWorkbenchGitRefs(refs).map((ref) => ref.name),
      ['main', 'release', 'v2.0', 'origin/main']
    )
    assert.equal(isWorkbenchGitHeadCommit(commit('a', refs)), true)
    assert.equal(isWorkbenchGitHeadCommit(commit('a', [{ kind: 'head', name: 'HEAD' }])), true)
    assert.equal(isWorkbenchGitHeadCommit(commit('a', [{ kind: 'branch', name: 'other' }])), false)

    const commits = [commit('aaa', refs), commit('bbb')]
    assert.deepEqual(filterWorkbenchGitLogCommits(commits, 'origin/MAIN'), [commits[0]])
    assert.deepEqual(filterWorkbenchGitLogCommits(commits, 'subject of bbb'), [commits[1]])
    // 没在搜索时原样返回：提交图按同一个数组的下标对行。
    assert.equal(filterWorkbenchGitLogCommits(commits, '  '), commits)
  })

  void test('only the rows near the viewport are rendered', () => {
    const window = (scrollTop: number, rowCount = 5_000): { start: number; end: number } =>
      resolveWorkbenchGitLogWindow({
        scrollTop,
        viewportHeight: 260,
        rowHeight: 26,
        rowCount,
        overscan: 12,
      })
    assert.deepEqual(window(0), { start: 0, end: 22 })
    assert.deepEqual(window(26 * 1_000), { start: 988, end: 1_022 })
    // 列表比视口短、滚过了头：范围不越界。
    assert.deepEqual(window(0, 5), { start: 0, end: 5 })
    assert.deepEqual(window(26 * 1_000, 5), { start: 5, end: 5 })
    const drawn = window(26 * 2_500)
    assert.ok(drawn.end - drawn.start < 40, 'a long log draws a few dozen rows, not thousands')
  })
})

void describe('Workbench Git commit graph: the tool window', () => {
  void test('shows every branch by default, limits to one on request, draws lanes and loads on scroll', () => {
    const panel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')
    const list = readSource('src/renderer/src/components/git/WorkbenchGitLogList.tsx')
    const refsPane = readSource('src/renderer/src/components/git/WorkbenchGitRefsPane.tsx')
    const hook = readSource('src/renderer/src/hooks/useWorkbenchGitLog.ts')
    const service = readSource('src/main/workspace/git/WorkbenchGitService.ts')

    // 默认全部分支（空串）；左侧点一个分支、或点范围标签，只看一个分支。
    assert.match(panel, /const \[logBranch, setLogBranch\] = useState\(''\)/u)
    assert.match(panel, /const scopeToggleTarget = logBranch \? '' : \(currentBranch \?\? ''\)/u)
    assert.match(refsPane, /data-active=\{logBranch === ''\}[\s\S]*?onSelectBranch\(''\)/u)
    assert.match(service, /args\.push\('--branches', '--remotes'\)/u)
    assert.doesNotMatch(service, /'--all'/u)

    // 泳道由纯函数排；搜索时不画图。
    assert.match(panel, /layoutWorkbenchGitGraph\(commits\)\.rows/u)
    assert.match(panel, /graph=\{searching \? null : graph\}/u)
    // 只画视口附近的行，快到末尾读下一页；一页一页读，仓库没变时只重读第一页。
    assert.match(list, /resolveWorkbenchGitLogWindow\(\{/u)
    assert.match(list, /commits\.slice\(start, end\)\.map/u)
    assert.match(list, /if \(end >= commits\.length - LoadMoreThresholdRows\) onLoadMore\(\)/u)
    assert.match(hook, /isSameWorkbenchGitLogHead\(current\.commits, firstPage\.commits\)/u)
    assert.match(hook, /skip,\n/u)
    // 行上有引用标签：分支、标签、HEAD。
    assert.match(list, /data-kind=\{ref\.kind\}/u)
    assert.match(list, /data-current=\{ref\.current \? 'true' : undefined\}/u)

    for (const key of [
      'workbench.gitLogAllBranches',
      'workbench.gitLogShowAllBranches',
      'workbench.gitLogShowCurrentBranch',
      'workbench.gitLogResultCountMore',
      'workbench.gitLogLoadOlder',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key, { branch: 'main', count: 3 })
      const en = translateWorkbenchAppMessage('en-US', key, { branch: 'main', count: 3 })
      assert.notEqual(en, key, `en-US is missing ${key}`)
      assert.notEqual(zh, en, `zh-CN is missing ${key}`)
    }
  })
})
