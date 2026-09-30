import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  MAX_WORKBENCH_RECENT_FILES,
  normalizeWorkbenchRecentFiles,
  readWorkbenchRecentFiles,
  recordWorkbenchRecentFile,
  saveWorkbenchRecentFiles,
} from '../src/renderer/src/models/files/workbenchRecentFiles'
import {
  buildWorkbenchQuickOpenFileItems,
  buildWorkbenchQuickOpenRecentItems,
  isWorkbenchProjectFileListChange,
  parseWorkbenchQuickOpenQuery,
  scoreWorkbenchQuickOpenPath,
} from '../src/renderer/src/models/layout/workbenchQuickOpenModel'
import type { StorageLike } from '../src/renderer/src/persistence/localStorageJsonStore'

function findPaths(
  files: readonly string[],
  query: string,
  options: { recentPaths?: string[]; activePath?: string; openTabPaths?: string[] } = {}
): string[] {
  return buildWorkbenchQuickOpenFileItems({
    files,
    openTabPaths: options.openTabPaths ?? [],
    recentPaths: options.recentPaths ?? [],
    activePath: options.activePath ?? null,
    query,
  }).map((item) => item.path)
}

function createStorage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

void describe('Quick Open input', () => {
  void test('reads path:line[:column] as a file position', () => {
    assert.deepEqual(parseWorkbenchQuickOpenQuery('math.ts:12'), {
      mode: 'files',
      text: 'math.ts',
      line: 12,
      column: null,
    })
    assert.deepEqual(parseWorkbenchQuickOpenQuery(' src/math.ts:12:5 '), {
      mode: 'files',
      text: 'src/math.ts',
      line: 12,
      column: 5,
    })
    assert.deepEqual(parseWorkbenchQuickOpenQuery('math.ts:12,5'), {
      mode: 'files',
      text: 'math.ts',
      line: 12,
      column: 5,
    })
    // 还没敲完：多出来的冒号、逗号不让结果一下子全没了。
    assert.deepEqual(parseWorkbenchQuickOpenQuery('math.ts:'), {
      mode: 'files',
      text: 'math.ts',
      line: null,
      column: null,
    })
    assert.deepEqual(parseWorkbenchQuickOpenQuery('math.ts:12:'), {
      mode: 'files',
      text: 'math.ts',
      line: 12,
      column: null,
    })
    assert.equal(parseWorkbenchQuickOpenQuery('math.ts:0').line, 1)
    assert.deepEqual(parseWorkbenchQuickOpenQuery('notes:draft'), {
      mode: 'files',
      text: 'notes:draft',
      line: null,
      column: null,
    })
    assert.deepEqual(parseWorkbenchQuickOpenQuery('quick open'), {
      mode: 'files',
      text: 'quick open',
      line: null,
      column: null,
    })
  })

  void test('reads :line as a jump in the current file and > as commands', () => {
    assert.deepEqual(parseWorkbenchQuickOpenQuery(':42'), {
      mode: 'line',
      text: '42',
      line: 42,
      column: null,
    })
    assert.deepEqual(parseWorkbenchQuickOpenQuery(': 42:7'), {
      mode: 'line',
      text: '42:7',
      line: 42,
      column: 7,
    })
    assert.equal(parseWorkbenchQuickOpenQuery(':').line, null)
    assert.equal(parseWorkbenchQuickOpenQuery(':abc').line, null)
    assert.deepEqual(parseWorkbenchQuickOpenQuery('>  save all'), {
      mode: 'commands',
      text: 'save all',
      line: null,
      column: null,
    })
    assert.equal(parseWorkbenchQuickOpenQuery('>').mode, 'commands')
  })

  void test('only changes that can add or remove files make the file list stale', () => {
    for (const path of ['.', 'src/a.ts', 'src/dist', 'packages/app/build', 'README.md'])
      assert.equal(isWorkbenchProjectFileListChange(path), true, path)
    for (const path of ['.git/HEAD', '.git/refs/heads/main', 'node_modules', 'packages/a/node_modules', 'dist', 'build', 'out'])
      assert.equal(isWorkbenchProjectFileListChange(path), false, path)
  })
})

void describe('Quick Open file ranking', () => {
  void test('ranks file name matches above directory matches', () => {
    assert.deepEqual(findPaths(['src/math/index.ts', 'lib/mathUtils.ts'], 'math'), [
      'lib/mathUtils.ts',
      'src/math/index.ts',
    ])
    // 以输入开头的文件名排在只是含有它的前面。
    assert.deepEqual(findPaths(['src/IconButton.tsx', 'src/Button.tsx'], 'button'), [
      'src/Button.tsx',
      'src/IconButton.tsx',
    ])
  })

  void test('breaks ties by shorter names, then shorter paths', () => {
    assert.deepEqual(
      findPaths(['packages/app/src/index.ts', 'src/index.tsx', 'src/index.ts'], 'index'),
      ['src/index.ts', 'packages/app/src/index.ts', 'src/index.tsx']
    )
  })

  void test('the exact path wins over everything else', () => {
    assert.deepEqual(findPaths(['src/app.ts', 'app.ts', 'src/app.tsx'], 'src/app.ts')[0], 'src/app.ts')
  })

  void test('every space-separated piece must match', () => {
    const files = ['src/models/quickOpenModel.ts', 'src/components/QuickOpen.tsx', 'src/models/other.ts']
    assert.deepEqual(findPaths(files, 'quick model'), ['src/models/quickOpenModel.ts'])
    assert.deepEqual(findPaths(files, 'models quick'), ['src/models/quickOpenModel.ts'])
    assert.deepEqual(findPaths(files, 'quick nothing'), [])
  })

  void test('returns the matched characters of the name and of the folder', () => {
    const nameMatch = scoreWorkbenchQuickOpenPath('src/components/QuickOpen.tsx', 'qo')
    assert.deepEqual(nameMatch?.nameMatches, [0, 5])
    assert.deepEqual(nameMatch?.directoryMatches, [])

    const pathMatch = scoreWorkbenchQuickOpenPath('src/components/QuickOpen.tsx', 'comp/qo')
    assert.deepEqual(pathMatch?.directoryMatches, [4, 5, 6, 7])
    // 目录与文件名之间的 `/` 两边都不显示，命中了也不标。
    assert.deepEqual(pathMatch?.nameMatches, [0, 5])

    const [item] = buildWorkbenchQuickOpenFileItems({
      files: ['src/components/QuickOpen.tsx'],
      openTabPaths: ['src/components/QuickOpen.tsx'],
      recentPaths: [],
      activePath: null,
      query: 'qo',
    })
    assert.equal(item?.name, 'QuickOpen.tsx')
    assert.equal(item?.directory, 'src/components')
    assert.equal(item?.isOpen, true)
    assert.equal(scoreWorkbenchQuickOpenPath('src/a.ts', 'zz'), null)
  })

  void test('boosts recently opened files within the same kind of match', () => {
    assert.deepEqual(findPaths(['a/util.ts', 'b/util.ts'], 'util'), ['a/util.ts', 'b/util.ts'])
    assert.deepEqual(findPaths(['a/util.ts', 'b/util.ts'], 'util', { recentPaths: ['b/util.ts'] }), [
      'b/util.ts',
      'a/util.ts',
    ])
    // 越近的提得越多。
    assert.deepEqual(
      findPaths(['a/util.ts', 'b/util.ts', 'c/util.ts'], 'util', {
        recentPaths: ['c/util.ts', 'b/util.ts'],
      }),
      ['c/util.ts', 'b/util.ts', 'a/util.ts']
    )
    // 当前文件不提：跳去当前文件用不着快速打开。
    assert.deepEqual(
      findPaths(['a/util.ts', 'b/util.ts'], 'util', {
        recentPaths: ['b/util.ts'],
        activePath: 'b/util.ts',
      }),
      ['a/util.ts', 'b/util.ts']
    )
  })

  void test('recency never lifts a weaker kind of match over a better one', () => {
    // 文件名正好是输入的，胜过最近打开过、只是以输入开头的。
    assert.deepEqual(
      findPaths(['src/helpers/formatDate.ts', 'src/format.ts'], 'format', {
        recentPaths: ['src/helpers/formatDate.ts'],
      }),
      ['src/format.ts', 'src/helpers/formatDate.ts']
    )
    // 文件名命中的永远在只有路径命中的前面。
    assert.deepEqual(
      findPaths(['model/view/index.ts', 'src/modelView.ts'], 'modelview', {
        recentPaths: ['model/view/index.ts'],
      }),
      ['src/modelView.ts', 'model/view/index.ts']
    )
  })

  void test('finds open tabs that are not in the file list yet', () => {
    assert.deepEqual(findPaths([], 'draft', { openTabPaths: ['notes/draft.md'] }), ['notes/draft.md'])
    assert.deepEqual(findPaths(['notes/draft.md'], 'draft', { openTabPaths: ['notes/draft.md'] }), [
      'notes/draft.md',
    ])
  })

  void test('stops at the limit', () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/file${index}.ts`)
    assert.equal(
      buildWorkbenchQuickOpenFileItems({
        files,
        openTabPaths: [],
        recentPaths: [],
        activePath: null,
        query: 'file',
        limit: 10,
      }).length,
      10
    )
    assert.equal(findPaths(files, '   ').length, 0)
  })
})

void describe('Quick Open recently opened files', () => {
  void test('lists the most recent first and the current file last', () => {
    const items = buildWorkbenchQuickOpenRecentItems({
      recentPaths: ['src/c.ts', 'src/b.ts', 'src/a.ts'],
      openTabPaths: ['src/c.ts', 'src/d.ts'],
      activePath: 'src/c.ts',
      files: null,
    })
    // 记下的在前，打开着但没记下的标签接在后面，当前文件放最后。
    assert.deepEqual(
      items.map((item) => item.path),
      ['src/b.ts', 'src/a.ts', 'src/d.ts', 'src/c.ts']
    )
    assert.deepEqual(
      items.map((item) => item.isOpen),
      [false, false, true, true]
    )
    assert.equal(items[0]?.name, 'b.ts')
    assert.equal(items[0]?.directory, 'src')
  })

  void test('leaves out files that are gone, but only when the file list is complete', () => {
    const recentPaths = ['src/gone.ts', 'src/kept.ts', 'src/open-but-gone.ts']
    const complete = buildWorkbenchQuickOpenRecentItems({
      recentPaths,
      openTabPaths: ['src/open-but-gone.ts'],
      activePath: null,
      files: ['src/kept.ts'],
    })
    assert.deepEqual(
      complete.map((item) => item.path),
      ['src/kept.ts', 'src/open-but-gone.ts']
    )

    const unknown = buildWorkbenchQuickOpenRecentItems({
      recentPaths,
      openTabPaths: [],
      activePath: null,
      files: null,
    })
    assert.deepEqual(
      unknown.map((item) => item.path),
      recentPaths
    )
  })

  void test('records a file by moving it to the front, keeping at most the limit', () => {
    assert.deepEqual(recordWorkbenchRecentFile(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'])
    assert.deepEqual(recordWorkbenchRecentFile(['a', 'b'], 'new'), ['new', 'a', 'b'])
    assert.deepEqual(recordWorkbenchRecentFile(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
    assert.deepEqual(recordWorkbenchRecentFile(['a'], '  '), ['a'])
  })

  void test('stores each project list separately and drops malformed entries', () => {
    const storage = createStorage()
    saveWorkbenchRecentFiles('project-a', ['src/a.ts', 'src/b.ts'], storage)
    saveWorkbenchRecentFiles('project-b', ['lib/c.ts'], storage)
    assert.deepEqual(readWorkbenchRecentFiles('project-a', storage), ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(readWorkbenchRecentFiles('project-b', storage), ['lib/c.ts'])
    assert.deepEqual(readWorkbenchRecentFiles('project-c', storage), [])

    storage.values.set(
      'velaros.workbench.recent-files.v1',
      JSON.stringify({ 'project-a': ['src/a.ts', 3, '', 'src/a.ts', ' src/b.ts '], broken: 'x' })
    )
    assert.deepEqual(readWorkbenchRecentFiles('project-a', storage), ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(readWorkbenchRecentFiles('broken', storage), [])

    storage.values.set('velaros.workbench.recent-files.v1', '{not json')
    assert.deepEqual(readWorkbenchRecentFiles('project-a', storage), [])

    const many = Array.from({ length: MAX_WORKBENCH_RECENT_FILES + 10 }, (_, index) => `f${index}`)
    assert.equal(normalizeWorkbenchRecentFiles(many).length, MAX_WORKBENCH_RECENT_FILES)
  })
})
