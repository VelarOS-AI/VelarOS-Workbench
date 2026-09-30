import { describe, expect, test } from 'bun:test'

import { highlightWorkbenchCodeSnippet } from '../src/renderer/src/models/editor/workbenchCodeSnippetHighlight'
import {
  buildWorkbenchProjectSearchRows,
  formatWorkbenchProjectSearchCount,
  isOpenableWorkbenchProjectSearchRow,
  mergeWorkbenchProjectSearchFiles,
  readWorkbenchProjectSearchSeed,
  searchWorkbenchEditorText,
} from '../src/renderer/src/models/files/workbenchProjectSearchModel'
import type { WorkbenchContentSearchFileResult, WorkbenchDirectoryEntry } from '../src/shared/contracts'
import { compileWorkbenchTextSearch, DefaultWorkbenchTextSearchOptions } from '../src/shared/workbenchTextSearch'

/**
 * 项目搜索面板的结果模型：开着的文件按编辑器正文算、盖过磁盘上的结果；结果展开成一样高的行，收起的文件
 * 不展开，没列全的文件说明还有几处；代码片段按确切的匹配位置标出，替换时可以预览。
 */

function matcher(query: string, regex = false) {
  const compiled = compileWorkbenchTextSearch({ ...DefaultWorkbenchTextSearchOptions, query, regex })
  if (compiled.status !== 'ready') throw new Error('query not ready')
  return compiled.matcher
}

function diskFile(path: string, matchCount: number): WorkbenchContentSearchFileResult {
  return {
    path,
    modifiedAt: 1,
    size: 10,
    matchCount,
    matches: Array.from({ length: matchCount }, (_, index) => ({
      line: index + 1,
      column: 1,
      endLine: index + 1,
      endColumn: 4,
      excerpt: 'foo',
      excerptMatchStart: 0,
      excerptMatchEnd: 3,
    })),
  }
}

describe('project search results model', () => {
  test('searches editor text with the shared rules, counting every match but listing up to the limit', () => {
    const file = searchWorkbenchEditorText({
      path: 'src/a.ts',
      content: 'foo()\n  // foo foo\n',
      modifiedAt: 5,
      size: 20,
      matcher: matcher('foo'),
      limit: 2,
    })
    expect(file.matchCount).toBe(3)
    expect(file.matches.map((match) => [match.line, match.column, match.excerpt])).toEqual([
      [1, 1, 'foo()'],
      [2, 6, '// foo foo'],
    ])
  })

  test('open files replace their disk results, files without matches drop out, paths are sorted', () => {
    const disk = new Map([
      ['src/b.ts', diskFile('src/b.ts', 2)],
      ['src/a.ts', diskFile('src/a.ts', 1)],
      ['README.md', diskFile('README.md', 1)],
    ])
    const editor = new Map([
      ['src/a.ts', diskFile('src/a.ts', 0)],
      ['src/c.ts', diskFile('src/c.ts', 4)],
    ])
    const files = mergeWorkbenchProjectSearchFiles(disk, editor)
    expect(files.map((file) => [file.path, file.source, file.fileName, file.directory])).toEqual([
      ['README.md', 'disk', 'README.md', ''],
      ['src/b.ts', 'disk', 'b.ts', 'src'],
      ['src/c.ts', 'editor', 'c.ts', 'src'],
    ])
  })

  test('rows put file names first, expand files unless collapsed and say how many matches are unlisted', () => {
    const files = mergeWorkbenchProjectSearchFiles(
      new Map([
        ['a.ts', { ...diskFile('a.ts', 2), matchCount: 5 }],
        ['b.ts', diskFile('b.ts', 1)],
      ]),
      new Map()
    )
    const entries: WorkbenchDirectoryEntry[] = [
      { name: 'a.ts', path: 'a.ts', type: 'file', size: 1, modifiedAt: 1, hasChildren: false },
    ]
    const rows = buildWorkbenchProjectSearchRows({
      entries,
      entriesCollapsed: false,
      files,
      collapsedPaths: new Set(['b.ts']),
    })
    expect(rows.map((row) => (row.kind === 'more' ? `more:${row.hidden}` : row.kind))).toEqual([
      'entries',
      'entry',
      'file',
      'match',
      'match',
      'more:3',
      'file',
    ])
    expect(rows.filter(isOpenableWorkbenchProjectSearchRow).map((row) => row.kind)).toEqual([
      'entry',
      'match',
      'match',
    ])
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)

    const collapsedEntries = buildWorkbenchProjectSearchRows({
      entries,
      entriesCollapsed: true,
      files: [],
      collapsedPaths: new Set(),
    })
    expect(collapsedEntries.map((row) => row.kind)).toEqual(['entries'])
  })

  test('⇧⌘F takes a selection within one line as the query, nothing else', () => {
    const content = 'const alpha = 1\nconst beta = alpha\n'
    const on = (startLine: number, startColumn: number, endLine: number, endColumn: number) =>
      readWorkbenchProjectSearchSeed(content, { startLine, startColumn, endLine, endColumn })
    expect(on(2, 7, 2, 11)).toBe('beta')
    expect(on(1, 7, 2, 5)).toBeUndefined()
    expect(on(1, 3, 1, 3)).toBeUndefined()
    expect(readWorkbenchProjectSearchSeed(content, undefined)).toBeUndefined()
    expect(readWorkbenchProjectSearchSeed('x'.repeat(500), { startLine: 1, startColumn: 1, endLine: 1, endColumn: 501 }))
      .toHaveLength(200)
  })

  test('counts read naturally in both languages', () => {
    const messages: Record<string, string> = {
      'workbench.projectSearchMatchCountOne': '{count} match',
      'workbench.projectSearchMatchCountOther': '{count} matches',
      'workbench.projectSearchFileCountOne': '{count} file',
      'workbench.projectSearchFileCountOther': '{count} files',
    }
    const t = (key: string, params?: Record<string, string | number>) =>
      (messages[key] ?? key).replace('{count}', String(params?.['count']))
    expect(formatWorkbenchProjectSearchCount(t, 'match', 1)).toBe('1 match')
    expect(formatWorkbenchProjectSearchCount(t, 'match', 3)).toBe('3 matches')
    expect(formatWorkbenchProjectSearchCount(t, 'file', 0)).toBe('0 files')
  })

  test('snippets mark the exact match range, also for regex matches the query text would not find', () => {
    const tokens = highlightWorkbenchCodeSnippet({
      path: 'src/index.ts',
      text: 'const total = calc(a1, b2)',
      theme: 'light-modern',
      match: { start: 19, end: 21 },
    })
    expect(tokens.map((token) => token.text).join('')).toBe('const total = calc(a1, b2)')
    expect(tokens.filter((token) => token.match).map((token) => token.text)).toEqual(['a1'])
  })
})
