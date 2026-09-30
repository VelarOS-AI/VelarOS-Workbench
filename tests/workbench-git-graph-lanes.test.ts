import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  layoutWorkbenchGitGraph,
  measureWorkbenchGitGraphLanes,
  type WorkbenchGitGraphCommit,
  WorkbenchGitGraphMaxLanes,
  type WorkbenchGitGraphRow,
} from '../src/renderer/src/models/git/workbenchGitGraph'

/** `sha:父1,父2` 这样写一段历史，子提交在前。 */
function history(...lines: string[]): WorkbenchGitGraphCommit[] {
  return lines.map((line) => {
    const [sha = '', parents = ''] = line.split(':')
    return { sha, parents: parents.split(',').filter(Boolean) }
  })
}

/** 一行画成字符：`*` 提交，`|` 直穿的线，` ` 空列；后面跟着会合（`<`）与往下接（`>`）的列。 */
function draw(rows: WorkbenchGitGraphRow[]): string[] {
  return rows.map((row) => {
    const cells = Array.from({ length: row.width }, (_, lane) =>
      lane === row.lane ? '*' : row.passing.includes(lane) ? '|' : ' '
    )
    const notes = [
      row.fromAbove ? '' : 'tip',
      row.mergingIn.length ? `<${row.mergingIn.join(',')}` : '',
      row.branchingOut.length ? `>${row.branchingOut.join(',')}` : 'root',
    ].filter(Boolean)
    return `${cells.join('').trimEnd()} ${notes.join(' ')}`
  })
}

void describe('Workbench Git commit graph lanes', () => {
  void test('a linear history is one straight lane', () => {
    const { rows, state } = layoutWorkbenchGitGraph(history('c:b', 'b:a', 'a:'))
    assert.deepEqual(draw(rows), ['* tip >0', '* >0', '* root'])
    assert.deepEqual(state.lanes, [])
  })

  void test('a merged feature branch leaves the mainline, runs beside it and joins at the fork point', () => {
    const { rows, state } = layoutWorkbenchGitGraph(
      history('merge:main2,feat2', 'main2:main1', 'feat2:feat1', 'main1:base', 'feat1:base', 'base:')
    )
    assert.deepEqual(draw(rows), [
      '* tip >0,1', // 合并提交：主线留在第 0 列，另一个父提交接到第 1 列
      '*| >0',
      '|* >1',
      '*| >0',
      '|* >1',
      '* <1 root', // 分叉点：两条线在这里会合
    ])
    assert.deepEqual(state.lanes, [])
  })

  void test('two unmerged branches each keep a lane, and a finished lane is reused', () => {
    const { rows } = layoutWorkbenchGitGraph(
      history('a2:a1', 'b1:base', 'a1:base', 'base:root', 'c1:root', 'root:')
    )
    assert.deepEqual(draw(rows), [
      '* tip >0',
      '|* tip >1', // 另一个分支的最新提交：右边新开一列
      '*| >0',
      '* <1 >0', // 两个分支的共同起点：第 1 列到此空出
      '|* tip >1', // 后来的分支接着用空出来的第 1 列
      '* <1 root',
    ])
  })

  void test('an octopus merge fans out to every parent, reusing a lane that already waits for one', () => {
    const { rows } = layoutWorkbenchGitGraph(
      history('x:p1', 'octopus:main,p1,p2', 'main:base', 'p1:base', 'p2:base', 'base:')
    )
    assert.deepEqual(draw(rows), [
      '* tip >0',
      '|* tip >1,0,2', // p1 已经有第 0 列在等：接过去，不另开一列；p2 新开第 2 列
      '|*| >1', // 主线的父提交留在合并提交自己的那一列
      '*|| >0',
      '||* >2',
      '* <1,2 root',
    ])
  })

  void test('a parent outside the listed commits keeps its lane open for the next page', () => {
    const first = layoutWorkbenchGitGraph(history('d:c', 'side:b', 'c:b'))
    assert.deepEqual(draw(first.rows), ['* tip >0', '|* tip >1', '*| >0'])
    assert.deepEqual(first.state.lanes, ['b', 'b'])

    // 接着上一页的状态排，与一次排完整段一模一样。
    const second = layoutWorkbenchGitGraph(history('b:a', 'a:'), first.state)
    const whole = layoutWorkbenchGitGraph(history('d:c', 'side:b', 'c:b', 'b:a', 'a:'))
    assert.deepEqual([...first.rows, ...second.rows], whole.rows)
    assert.deepEqual(draw(second.rows), ['* <1 >0', '* root'])
    assert.deepEqual(second.state, whole.state)
  })

  void test('the graph column is as wide as the busiest row, up to a cap', () => {
    const { rows } = layoutWorkbenchGitGraph(
      history('merge:main2,feat2', 'main2:main1', 'feat2:feat1', 'main1:base', 'feat1:base', 'base:')
    )
    assert.equal(measureWorkbenchGitGraphLanes(rows), 2)
    assert.equal(measureWorkbenchGitGraphLanes([]), 1)

    // 几十个没合并的分支同时开着：图的宽度封顶，不把提交说明挤没。
    const tips = Array.from({ length: 40 }, (_, index) => `tip${index}:base`)
    const wide = layoutWorkbenchGitGraph(history(...tips, 'base:'))
    assert.equal(wide.rows.at(-2)?.lane, 39)
    assert.equal(measureWorkbenchGitGraphLanes(wide.rows), WorkbenchGitGraphMaxLanes)
    assert.deepEqual(wide.rows.at(-1)?.mergingIn.length, 39)
  })

  void test('ten thousand commits with long-lived side branches lay out well within a frame budget', () => {
    const commits: WorkbenchGitGraphCommit[] = []
    for (let index = 10_000; index > 0; index -= 1) {
      // 每 50 个主线提交合并进来一个 3 个提交的特性分支。
      if (index % 50 === 0) {
        commits.push({ sha: `m${index}`, parents: [`m${index - 1}`, `f${index}c`] })
        commits.push({ sha: `f${index}c`, parents: [`f${index}b`] })
        commits.push({ sha: `f${index}b`, parents: [`f${index}a`] })
        commits.push({ sha: `f${index}a`, parents: [`m${index - 1}`] })
      } else commits.push({ sha: `m${index}`, parents: index > 1 ? [`m${index - 1}`] : [] })
    }
    const startedAt = performance.now()
    const { rows, state } = layoutWorkbenchGitGraph(commits)
    assert.ok(performance.now() - startedAt < 250, 'layout stays fast on a long history')
    assert.equal(rows.length, commits.length)
    assert.equal(measureWorkbenchGitGraphLanes(rows), 2)
    assert.deepEqual(state.lanes, [])
  })
})
