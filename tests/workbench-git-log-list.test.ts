import assert from 'node:assert/strict'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import { layoutWorkbenchGitGraph } from '../src/renderer/src/models/git/workbenchGitGraph'
import type { WorkspaceGitLogEntry, WorkspaceGitRef } from '../src/shared/contracts'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n')
const { WorkbenchGitLogList } = await import(
  '../src/renderer/src/components/git/WorkbenchGitLogList'
)

function commit(
  sha: string,
  parents: string[],
  refs: WorkspaceGitRef[] = []
): WorkspaceGitLogEntry {
  return {
    sha,
    shortSha: sha,
    subject: `subject ${sha}`,
    authorName: 'Ada',
    authorEmail: null,
    authoredAt: 0,
    parents,
    refs,
  }
}

function render(commits: WorkspaceGitLogEntry[], options: { graph: boolean }): string {
  const graph = layoutWorkbenchGitGraph(commits).rows
  return renderToStaticMarkup(
    createElement(WorkbenchLocalizationProvider, {
      value: { locale: 'en-US', setLocale: async () => undefined, t: (key) => key },
      children: createElement(WorkbenchGitLogList, {
        commits,
        graph: options.graph ? graph : null,
        graphLanes: 2,
        selectedSha: 'merge',
        onSelect: () => undefined,
        hasMore: true,
        autoLoadMore: options.graph,
        loadMoreLabel: 'load older',
        onLoadMore: () => undefined,
        ariaLabel: 'log',
      }),
    })
  )
}

void describe('Workbench Git log list', () => {
  const commits = [
    commit('merge', ['main1', 'feat1'], [
      { kind: 'remote', name: 'origin/main' },
      { kind: 'branch', name: 'main', current: true },
      { kind: 'tag', name: 'v1.0' },
      { kind: 'branch', name: 'release' },
      { kind: 'tag', name: 'extra' },
    ]),
    commit('main1', ['base']),
    commit('feat1', ['base'], [{ kind: 'branch', name: 'feature' }]),
    commit('base', []),
  ]

  void test('draws a graph cell, ref labels and the commit on every row', () => {
    const markup = render(commits, { graph: true })
    assert.equal(markup.match(/role="option"/gu)?.length, 4)
    // 每行一格提交图，宽度是两条泳道。
    assert.equal(markup.match(/<svg width="36" height="26" aria-hidden="true">/gu)?.length, 4)
    // 合并提交：自己的线往下，另一条弯到右边那一列；HEAD 所在的提交是空心圆点。
    assert.match(markup, /<path d="M 12 13 Q 24 13 24 26"/u)
    assert.match(markup, /<circle[^>]*data-head="true"/u)
    // 分叉点：右边那条线并回来。
    assert.match(markup, /<path d="M 24 0 Q 24 13 12 13"/u)
    // 引用标签：当前分支在最前，最多三个，多的收成 +N。
    const labels = [...markup.matchAll(/data-kind="(\w+)"(?: data-current="true")? title="([^"]*)"/gu)]
      .slice(0, 4)
      .map((match) => `${match[1]}:${match[2]?.replace(/\s|&#x?\w+;/gu, ' ')}`)
    assert.deepEqual(labels, ['branch:main', 'branch:release', 'tag:v1.0', 'more:extra origin/main'])
    assert.match(markup, /data-kind="more"[^>]*>\+2</u)
    assert.match(markup, /data-kind="branch" data-current="true" title="main"/u)
    assert.match(markup, /aria-selected="true"[^>]*data-active="true"/u)
    assert.match(markup, /subject base/u)
    // 自动读下一页时不放按钮。
    assert.doesNotMatch(markup, /load older/u)
  })

  void test('a search result list has no graph and offers to load older commits', () => {
    const markup = render(commits.slice(1, 3), { graph: false })
    assert.doesNotMatch(markup, /<svg width="36"/u)
    assert.match(markup, /<button[^>]*>load older<\/button>/u)
  })
})
