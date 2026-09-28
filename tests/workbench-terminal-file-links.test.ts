import { describe, expect, test } from 'bun:test'

import {
  findWorkbenchTerminalFileLinks,
  listWorkbenchTerminalLinkCandidates,
  parseWorkbenchTerminalCwdReport,
  resolveWorkbenchTerminalLinkPath,
  toWorkbenchProjectRelativePath,
} from '../src/renderer/src/models/commands/workbenchTerminalFileLinks'

/** 每个链接在原文里盖住的文字，连同解析出的路径与行列。 */
function describeLinks(text: string) {
  return findWorkbenchTerminalFileLinks(text).map(({ start, end, ...link }) => ({
    text: text.slice(start, end),
    ...link,
  }))
}

describe('file paths in terminal output', () => {
  test('compiler, linter and stack trace locations', () => {
    expect(describeLinks('src/app.ts:12:5 - error TS2322: nope')).toEqual([
      { text: 'src/app.ts:12:5', path: 'src/app.ts', line: 12, column: 5 },
    ])
    expect(describeLinks('src/app.ts(12,5): error TS2322: nope')).toEqual([
      { text: 'src/app.ts(12,5)', path: 'src/app.ts', line: 12, column: 5 },
    ])
    expect(describeLinks('    at add (/Users/me/proj/src/math.ts:10:3)')).toEqual([
      { text: '/Users/me/proj/src/math.ts:10:3', path: '/Users/me/proj/src/math.ts', line: 10, column: 3 },
    ])
    expect(describeLinks('  --> src/main.rs:2:5')).toEqual([
      { text: 'src/main.rs:2:5', path: 'src/main.rs', line: 2, column: 5 },
    ])
    expect(describeLinks('./main.go:7: undefined: x')).toEqual([
      { text: './main.go:7', path: './main.go', line: 7 },
    ])
    expect(describeLinks('PHP Fatal error: oops in /var/www/index.php on line 12')).toEqual([
      { text: '/var/www/index.php on line 12', path: '/var/www/index.php', line: 12 },
    ])
  })

  test('Python frames, Node ESM file URLs and Windows paths', () => {
    expect(describeLinks('  File "/srv/my app/main.py", line 12, in <module>')).toEqual([
      { text: '/srv/my app/main.py', path: '/srv/my app/main.py', line: 12 },
    ])
    expect(describeLinks('  File "<frozen importlib._bootstrap>", line 1')).toEqual([])
    expect(describeLinks('    at file:///Users/me/proj/src/index.mjs:3:9')).toEqual([
      { text: 'file:///Users/me/proj/src/index.mjs:3:9', path: '/Users/me/proj/src/index.mjs', line: 3, column: 9 },
    ])
    expect(describeLinks('see file:///Users/me/My%20Docs/a.mjs.')).toEqual([
      { text: 'file:///Users/me/My%20Docs/a.mjs', path: '/Users/me/My Docs/a.mjs' },
    ])
    expect(describeLinks(String.raw`C:\work\app\src\index.ts:4:2 warning`)).toEqual([
      { text: String.raw`C:\work\app\src\index.ts:4:2`, path: String.raw`C:\work\app\src\index.ts`, line: 4, column: 2 },
    ])
  })

  test('framework route folders and file names from ls', () => {
    expect(describeLinks('./app/(shop)/[slug]/page.tsx:8:1 Type error')).toEqual([
      { text: './app/(shop)/[slug]/page.tsx:8:1', path: './app/(shop)/[slug]/page.tsx', line: 8, column: 1 },
    ])
    expect(describeLinks('src/routes/+page.svelte  node_modules/@scope/pkg/index.js')).toEqual([
      { text: 'src/routes/+page.svelte', path: 'src/routes/+page.svelte' },
      { text: 'node_modules/@scope/pkg/index.js', path: 'node_modules/@scope/pkg/index.js' },
    ])
    expect(describeLinks('README.md  package.json  src  文档/说明.md')).toEqual([
      { text: 'README.md', path: 'README.md' },
      { text: 'package.json', path: 'package.json' },
      { text: '文档/说明.md', path: '文档/说明.md' },
    ])
  })

  test('leaves out sentence punctuation, URLs, times and plain words', () => {
    expect(describeLinks('See src/a.ts. Then [lib/b.ts], (c/d.ts)')).toEqual([
      { text: 'src/a.ts', path: 'src/a.ts' },
      { text: 'lib/b.ts', path: 'lib/b.ts' },
      { text: 'c/d.ts', path: 'c/d.ts' },
    ])
    expect(describeLinks('open http://localhost:3000/src/app.ts or https://x.dev/a/b.js')).toEqual([])
    expect(describeLinks('12:30:05 started on 127.0.0.1:8080, v1.2.3')).toEqual([])
    expect(describeLinks('Starting the dev server')).toEqual([])
    // 词中间、网址主机后面的不截。
    expect(describeLinks('error:src/a.ts localhost:3000/api/x.json')).toEqual([
      { text: 'localhost:3000', path: 'localhost', line: 3000 },
    ])
  })

  test('a path that stops before other name characters is not cut out of a longer word', () => {
    expect(describeLinks('src/a.ts-backup')).toEqual([{ text: 'src/a.ts-backup', path: 'src/a.ts-backup' }])
    expect(describeLinks('git diff a/src/x.ts b/src/x.ts')).toEqual([
      { text: 'a/src/x.ts', path: 'a/src/x.ts' },
      { text: 'b/src/x.ts', path: 'b/src/x.ts' },
    ])
  })
})

describe('resolving terminal paths into the project', () => {
  test('relative paths follow the directory, absolute paths stay', () => {
    expect(resolveWorkbenchTerminalLinkPath('/p/app', 'src/a.ts')).toBe('/p/app/src/a.ts')
    expect(resolveWorkbenchTerminalLinkPath('/p/app/src/', './../lib/./b.ts')).toBe('/p/app/lib/b.ts')
    expect(resolveWorkbenchTerminalLinkPath('/p/app', '/etc/hosts')).toBe('/etc/hosts')
    expect(resolveWorkbenchTerminalLinkPath('C:\\p\\app', 'src\\a.ts')).toBe('C:/p/app/src/a.ts')
    expect(resolveWorkbenchTerminalLinkPath('/p/app', '~/notes.md')).toBeNull()
  })

  test('only paths inside the project have a project path', () => {
    expect(toWorkbenchProjectRelativePath('/p/app', '/p/app/src/a.ts')).toBe('src/a.ts')
    expect(toWorkbenchProjectRelativePath('/p/app/', '/p/app/src/a.ts')).toBe('src/a.ts')
    expect(toWorkbenchProjectRelativePath('/p/app', '/p/application/a.ts')).toBeNull()
    expect(toWorkbenchProjectRelativePath('/p/app', '/p/app')).toBeNull()
    expect(toWorkbenchProjectRelativePath('/tmp/lab', '/private/tmp/lab/a.ts')).toBe('a.ts')
    expect(toWorkbenchProjectRelativePath('/private/tmp/lab', '/tmp/lab/a.ts')).toBe('a.ts')
    expect(toWorkbenchProjectRelativePath('C:\\Work\\App', 'c:/work/app/src/a.ts')).toBe('src/a.ts')
  })

  test('tries the shell directory first, then the project root, then without the git diff prefix', () => {
    expect(listWorkbenchTerminalLinkCandidates('/p/app', '/p/app/packages/web', 'src/a.ts')).toEqual([
      'packages/web/src/a.ts',
      'src/a.ts',
    ])
    expect(listWorkbenchTerminalLinkCandidates('/p/app', '/p/app', 'b/src/a.ts')).toEqual(['b/src/a.ts', 'src/a.ts'])
    expect(listWorkbenchTerminalLinkCandidates('/p/app', '/p/app', '/p/app/src/a.ts')).toEqual(['src/a.ts'])
    expect(listWorkbenchTerminalLinkCandidates('/p/app', '/p/app', '/etc/hosts')).toEqual([])
    expect(listWorkbenchTerminalLinkCandidates('/p/app', '/elsewhere', '../x.ts')).toEqual([])
  })

  test('reads the current directory the shell reports with OSC 7', () => {
    expect(parseWorkbenchTerminalCwdReport('file://my-mac.local/Users/me/My%20App')).toBe('/Users/me/My App')
    expect(parseWorkbenchTerminalCwdReport('file:///C:/work/app')).toBe('C:/work/app')
    expect(parseWorkbenchTerminalCwdReport('file://host/bad%zz')).toBeNull()
    expect(parseWorkbenchTerminalCwdReport('/not/a/url')).toBeNull()
  })
})
