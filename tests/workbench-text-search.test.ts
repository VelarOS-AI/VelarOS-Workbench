import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import { buildWorkbenchEditorSearchQuery } from '../src/renderer/src/models/editor/workbenchEditorFind'
import {
  compareWorkbenchSearchPaths,
  compileWorkbenchSearchPathFilter,
  isWorkbenchSearchDirectoryExcluded,
  isWorkbenchSearchPathIncluded,
  splitWorkbenchSearchGlobs,
} from '../src/shared/workbenchSearchGlob'
import {
  buildWorkbenchTextSearchPreview,
  compileWorkbenchTextSearch,
  DefaultWorkbenchTextSearchOptions,
  expandWorkbenchTextSearchReplacement,
  replaceWorkbenchTextSearchMatches,
  resolveWorkbenchTextOffset,
  scanWorkbenchTextSearch,
  type WorkbenchTextSearchHit,
  type WorkbenchTextSearchMatcher,
  type WorkbenchTextSearchQuery,
  workbenchTextSearchRangeKey,
} from '../src/shared/workbenchTextSearch'

/**
 * 项目搜索与替换的匹配规则（main 与 renderer 共用）：开关与编辑器里的查找一致，行列号与编辑器一致，
 * 正则替换认捕获组；包含 / 排除的文件模式与 VS Code 的搜索面板一致。
 */

function matcher(query: string, options: Partial<WorkbenchTextSearchQuery> = {}): WorkbenchTextSearchMatcher {
  const compiled = compileWorkbenchTextSearch({ ...DefaultWorkbenchTextSearchOptions, query, ...options })
  if (compiled.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(compiled)}`)
  return compiled.matcher
}

function hits(content: string, query: string, options: Partial<WorkbenchTextSearchQuery> = {}): WorkbenchTextSearchHit[] {
  const found: WorkbenchTextSearchHit[] = []
  scanWorkbenchTextSearch(content, matcher(query, options), (hit) => {
    found.push({ ...hit, groups: [...hit.groups] })
  })
  return found
}

function texts(content: string, query: string, options: Partial<WorkbenchTextSearchQuery> = {}): string[] {
  return hits(content, query, options).map((hit) => `${hit.line}:${hit.column}:${content.slice(hit.from, hit.to)}`)
}

const source = 'const calc = new Calculator()\ncalc.add(1)\nconst recalc = calc\n'

describe('project search matching', () => {
  test('is case-insensitive by default and honours match case, whole word and regex', () => {
    expect(texts(source, 'calc')).toEqual(['1:7:calc', '1:18:Calc', '2:1:calc', '3:9:calc', '3:16:calc'])
    expect(texts(source, 'calc', { matchCase: true })).toHaveLength(4)
    expect(texts(source, 'calc', { wholeWord: true })).toEqual(['1:7:calc', '2:1:calc', '3:16:calc'])
    expect(texts(source, 'c(al)c\\b', { regex: true, matchCase: true })).toEqual([
      '1:7:calc',
      '2:1:calc',
      '3:9:calc',
      '3:16:calc',
    ])
    // 全字匹配按 Unicode 认词：中文之间的英文不算一个词的边界。
    expect(texts('值calc值 calc', 'calc', { wholeWord: true })).toEqual(['1:8:calc'])
  })

  test('treats plain queries literally and reports an invalid regex instead of throwing', () => {
    expect(texts('a.b axb a\\nb', 'a.b')).toEqual(['1:1:a.b'])
    expect(texts('a.b axb a\\nb', 'a\\nb')).toEqual(['1:9:a\\nb'])
    const invalid = compileWorkbenchTextSearch({ ...DefaultWorkbenchTextSearchOptions, query: 'foo(', regex: true })
    expect(invalid.status).toBe('invalid')
    expect(invalid.status === 'invalid' && invalid.message.length > 0).toBe(true)
    expect(compileWorkbenchTextSearch({ ...DefaultWorkbenchTextSearchOptions, query: '' }).status).toBe('empty')
  })

  test('gives editor line and column numbers, also across lines and after surrogate pairs', () => {
    const content = 'one\n😀 two\nthree four\nfive'
    const [two] = hits(content, 'two')
    expect(two).toMatchObject({ line: 2, column: 4, endLine: 2, endColumn: 7, lineStart: 4 })
    // `\s` 能跨行（与编辑器里的正则查找一样），结束位置落在下一行。
    const [spanning] = hits(content, 'four\\s+fi', { regex: true })
    expect(spanning).toMatchObject({ line: 3, column: 7, endLine: 4, endColumn: 3 })
    const [lineEnd] = hits(content, 'four\\n', { regex: true })
    expect(lineEnd).toMatchObject({ line: 3, endLine: 4, endColumn: 1 })
    expect(resolveWorkbenchTextOffset(content, 3, 7)).toBe(content.indexOf('four'))
    expect(resolveWorkbenchTextOffset(content, 1, 99)).toBe(3)
    expect(resolveWorkbenchTextOffset(content, 9, 1)).toBe(content.length)
  })

  test('skips empty matches', () => {
    expect(texts('ab\n\nb', '^', { regex: true })).toEqual([])
    expect(texts('xab', 'a*', { regex: true })).toEqual(['1:2:a'])
  })

  test('previews the matched line without its indentation and cuts long lines around the match', () => {
    const content = '\t\t  return value\n'
    const [hit] = hits(content, 'value')
    const preview = buildWorkbenchTextSearchPreview(content, hit!)
    expect(preview).toEqual({ text: 'return value', matchStart: 7, matchEnd: 12 })

    const long = `${'word '.repeat(40)}needle ${'tail '.repeat(60)}`
    const [longHit] = hits(long, 'needle')
    const longPreview = buildWorkbenchTextSearchPreview(long, longHit!)
    expect(longPreview.text.startsWith('...word ')).toBe(true)
    expect(longPreview.text.endsWith('...')).toBe(true)
    expect(longPreview.text.length).toBeLessThanOrEqual(166)
    expect(longPreview.text.slice(longPreview.matchStart, longPreview.matchEnd)).toBe('needle')

    // 跨行的匹配只标到这一行的末尾。
    const spanning = 'let a = 1\nlet b = 2'
    const [spanningHit] = hits(spanning, '1\\s+let', { regex: true })
    const spanningPreview = buildWorkbenchTextSearchPreview(spanning, spanningHit!)
    expect(spanningPreview.text.slice(spanningPreview.matchStart, spanningPreview.matchEnd)).toBe('1')
  })
})

describe('project search agrees with the in-file find', () => {
  // 在编辑器里查找与在整个项目里查找，同样的查找词与开关找到同样的地方（项目搜索不报空匹配）。
  const documents = [
    source,
    'foo_bar foo-bar Foo\tfoo\nfoobar é foo\n  foo()\n',
    '中文 测试 test_测试 测试a\n😀test😀 test\r\n$1 a.b a*b\n',
    'alpha\n\nbeta  gamma\nALPHA beta\n',
  ]
  const queries: Array<Partial<WorkbenchTextSearchQuery> & { query: string }> = [
    { query: 'foo' },
    { query: 'foo', matchCase: true },
    { query: 'foo', wholeWord: true },
    { query: 'test', wholeWord: true },
    { query: '测试', wholeWord: true },
    { query: 'a.b' },
    { query: 'a*b' },
    { query: '$1' },
    { query: 'foo\\w*', regex: true },
    { query: '^\\s*\\w+', regex: true },
    { query: 'beta\\s+\\w+', regex: true },
    { query: '[^a-z ]+', regex: true, matchCase: true },
    { query: 'alpha$', regex: true },
    { query: '\\bfoo\\b', regex: true, wholeWord: true },
    { query: 'a*', regex: true },
  ]

  test('finds the same ranges for every query and option', () => {
    for (const doc of documents) {
      const state = EditorState.create({ doc })
      for (const spec of queries) {
        const query = { ...DefaultWorkbenchTextSearchOptions, ...spec }
        const expected: string[] = []
        const cursor = buildWorkbenchEditorSearchQuery({
          query: query.query,
          replace: '',
          caseSensitive: query.matchCase,
          wholeWord: query.wholeWord,
          regexp: query.regex,
          inSelection: false,
        }).getCursor(state)
        for (let next = cursor.next(); !next.done; next = cursor.next())
          if (next.value.to > next.value.from) expected.push(`${next.value.from}-${next.value.to}`)

        // 编辑器的正文把 \r\n 当成一次换行；项目搜索拿到的正文已经统一成 LF，这里也按编辑器的正文比。
        const content = state.doc.toString()
        const actual = hits(content, query.query, query).map((hit) => `${hit.from}-${hit.to}`)
        expect({ doc: content, spec, ranges: actual }).toEqual({ doc: content, spec, ranges: expected })
      }
    }
  })
})

describe('project search replacement', () => {
  test('uses the replacement literally unless the query is a regex', () => {
    const literal = replaceWorkbenchTextSearchMatches('a1 a2', matcher('a'), '$1\\n')
    expect(literal).toEqual({ content: '$1\\n1 $1\\n2', count: 2 })
  })

  test('expands $1, $&, $$ and escapes in regex replacements', () => {
    const regex = matcher('(\\w+)@(\\w+)', { regex: true })
    expect(replaceWorkbenchTextSearchMatches('mail alice@home now', regex, '$2:$1 [$&] $$ $3').content).toBe(
      'mail home:alice [alice@home] $ $3 now'
    )
    // `$12` 在只有两个捕获组时是 `$1` 跟着 2；`\n`、`\t` 是换行、制表符。
    expect(expandWorkbenchTextSearchReplacement({ ...DefaultWorkbenchTextSearchOptions, regex: true }, '$12\\n\\t\\\\', [
      'ab',
      'a',
      'b',
    ])).toBe('a2\n\t\\')
  })

  test('replaces only the selected matches', () => {
    const content = 'foo bar\nfoo baz\nfoo'
    const search = matcher('foo')
    const [, second] = hits(content, 'foo')
    const selected = new Set([workbenchTextSearchRangeKey(second!)])
    const result = replaceWorkbenchTextSearchMatches(content, search, 'qux', (hit) =>
      selected.has(workbenchTextSearchRangeKey(hit))
    )
    expect(result).toEqual({ content: 'foo bar\nqux baz\nfoo', count: 1 })
    expect(replaceWorkbenchTextSearchMatches(content, matcher('nothing'), 'x')).toEqual({ content, count: 0 })
  })
})

describe('project search file patterns', () => {
  const included = (include: string, exclude: string, paths: string[]): string[] => {
    const filter = compileWorkbenchSearchPathFilter(include, exclude)
    return paths.filter((path) => isWorkbenchSearchPathIncluded(filter, path))
  }
  const paths = [
    'src/app.ts',
    'src/app.test.ts',
    'src/view/button.tsx',
    'packages/web/src/index.ts',
    'README.md',
    'docs/guide.md',
    'build.ts',
  ]

  test('splits on commas outside braces', () => {
    expect(splitWorkbenchSearchGlobs(' src/**, *.{ts,tsx} ,, ')).toEqual(['src/**', '*.{ts,tsx}'])
  })

  test('matches at any depth unless anchored with ./, and folders take their files', () => {
    expect(included('src/**, *.md', '', paths)).toEqual([
      'src/app.ts',
      'src/app.test.ts',
      'src/view/button.tsx',
      'packages/web/src/index.ts',
      'README.md',
      'docs/guide.md',
    ])
    expect(included('./src', '', paths)).toEqual(['src/app.ts', 'src/app.test.ts', 'src/view/button.tsx'])
    expect(included('src/', '', paths)).toEqual(included('src/**', '', paths))
    expect(included('*.{ts,tsx}', '**/*.test.ts', paths)).toEqual([
      'src/app.ts',
      'src/view/button.tsx',
      'packages/web/src/index.ts',
      'build.ts',
    ])
    expect(included('', 'docs, readme.MD', paths)).toEqual([
      'src/app.ts',
      'src/app.test.ts',
      'src/view/button.tsx',
      'packages/web/src/index.ts',
      'build.ts',
    ])
    expect(included('src/*/button.tsx, [ab]uild.ts', '', paths)).toEqual(['src/view/button.tsx', 'build.ts'])
    expect(included('src/**/index.ts', '', paths)).toEqual(['packages/web/src/index.ts'])
    // 写不成正则的字符集按字面算，不抛错。
    expect(included('[z-a].ts', '', ['[z-a].ts', 'z.ts'])).toEqual(['[z-a].ts'])
  })

  test('excluded folders can be skipped without walking them', () => {
    const filter = compileWorkbenchSearchPathFilter('', '**/generated, ./vendor')
    expect(isWorkbenchSearchDirectoryExcluded(filter, 'src/generated')).toBe(true)
    expect(isWorkbenchSearchDirectoryExcluded(filter, 'vendor')).toBe(true)
    expect(isWorkbenchSearchDirectoryExcluded(filter, 'lib/vendor')).toBe(false)
    expect(isWorkbenchSearchDirectoryExcluded(filter, 'src')).toBe(false)
  })

  test('orders paths folder by folder, ignoring case', () => {
    expect(['src-old/a.ts', 'src/b.ts', 'Src/c.ts', 'README.md', 'src/a/z.ts'].sort(compareWorkbenchSearchPaths)).toEqual([
      'README.md',
      'src/a/z.ts',
      'src/b.ts',
      'Src/c.ts',
      'src-old/a.ts',
    ])
  })
})
