import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import {
  listWorkbenchEditorConfigPaths,
  parseWorkbenchEditorConfig,
  resolveWorkbenchEditorConfig,
  type WorkbenchEditorConfigLocation,
} from '../src/renderer/src/models/editor/workbenchEditorConfig'
import {
  buildWorkbenchIndentationConversion,
  detectWorkbenchIndentation,
  resolveWorkbenchIndentation,
  workbenchIndentUnit,
} from '../src/renderer/src/models/editor/workbenchIndentation'

function at(directory: string, text: string): WorkbenchEditorConfigLocation {
  return { directory, file: parseWorkbenchEditorConfig(text) }
}

describe('.editorconfig', () => {
  test('is looked up from the file’s folder up to the project root', () => {
    expect(listWorkbenchEditorConfigPaths('src/app/main.ts')).toEqual([
      'src/app/.editorconfig',
      'src/.editorconfig',
      '.editorconfig',
    ])
    expect(listWorkbenchEditorConfigPaths('README.md')).toEqual(['.editorconfig'])
  })

  test('sections match by file name anywhere, or by path when they contain a slash', () => {
    const config = at(
      '',
      [
        'root = true',
        '[*]',
        'indent_style = space',
        'indent_size = 2',
        '[*.{py,pyi}]',
        'indent_size = 4',
        '[Makefile]',
        'indent_style = tab',
        '[lib/**.js]',
        'indent_size = 8',
        '[/scripts/*.sh]',
        'indent_size = 3',
        '[v{1..3}.txt]',
        'indent_size = 6',
      ].join('\n')
    )
    const resolve = (path: string) => resolveWorkbenchEditorConfig([config], path)
    expect(resolve('src/a.ts')).toEqual({ indentStyle: 'space', indentSize: 2 })
    expect(resolve('tools/gen.py')).toEqual({ indentStyle: 'space', indentSize: 4 })
    expect(resolve('build/Makefile')).toEqual({ indentStyle: 'tab', indentSize: 2 })
    expect(resolve('lib/deep/x.js')).toEqual({ indentStyle: 'space', indentSize: 8 })
    expect(resolve('src/lib/x.js')).toEqual({ indentStyle: 'space', indentSize: 2 })
    expect(resolve('scripts/run.sh')).toEqual({ indentStyle: 'space', indentSize: 3 })
    expect(resolve('scripts/sub/run.sh')).toEqual({ indentStyle: 'space', indentSize: 2 })
    expect(resolve('v2.txt').indentSize).toBe(6)
    expect(resolve('v4.txt').indentSize).toBe(2)
  })

  test('nearer files win, and a root file stops the search', () => {
    const nested = at('packages/app', '[*.ts]\nindent_size = 4\n')
    const root = at('', 'root = true\n[*]\nindent_style = space\nindent_size = 2\ntab_width = 8\n')
    const outer = at('', '[*]\nindent_style = tab\n')
    expect(resolveWorkbenchEditorConfig([nested, root], 'packages/app/src/a.ts')).toEqual({
      indentStyle: 'space',
      indentSize: 4,
      tabWidth: 8,
    })
    expect(resolveWorkbenchEditorConfig([root, outer], 'a.ts').indentStyle).toBe('space')
  })

  test('ignores comments, unset values and nonsense sizes', () => {
    const config = at(
      '',
      '# comment\n; comment\n[*]\nindent_style = space\nindent_size = 4\n[*.md]\nindent_size = unset\ntab_width = lots\n'
    )
    expect(resolveWorkbenchEditorConfig([config], 'a.md')).toEqual({ indentStyle: 'space' })
  })
})

describe('indentation detection', () => {
  test('finds the step of space indentation, ignoring one-space comment alignment', () => {
    const fourSpaces = [
      '/**',
      ' * Adds numbers.',
      ' */',
      'export function add(a: number, b: number): number {',
      '    if (a > b) {',
      '        return a + b',
      '    }',
      '    return b',
      '}',
    ].join('\n')
    expect(detectWorkbenchIndentation(fourSpaces)).toEqual({ style: 'space', size: 4 })
    expect(detectWorkbenchIndentation('a {\n  b {\n    c\n  }\n}\n')).toEqual({ style: 'space', size: 2 })
  })

  test('prefers tabs when most indented lines use them, and gives up without indented lines', () => {
    expect(detectWorkbenchIndentation('func main() {\n\tfmt.Println()\n\tif x {\n\t\treturn\n\t}\n}\n')).toEqual({
      style: 'tab',
      size: 4,
    })
    expect(detectWorkbenchIndentation('const a = 1\n\nconst b = 2\n')).toBeNull()
    expect(detectWorkbenchIndentation('')).toBeNull()
  })

  test('ignores whitespace-only lines and preserves the surrounding indentation', () => {
    expect(detectWorkbenchIndentation('    \nx\n')).toBeNull()
    expect(
      detectWorkbenchIndentation(['root {', '\t ', '  child', '        ', '\t', '}'].join('\n'))
    ).toEqual({ style: 'space', size: 2 })
  })

  test('uses .editorconfig first, then the detected style, then the language default', () => {
    const detected = { style: 'space', size: 4 } as const
    expect(resolveWorkbenchIndentation({ path: 'a.ts', detected, editorConfig: null })).toEqual({
      style: 'space',
      size: 4,
      tabSize: 4,
      source: 'detected',
    })
    expect(
      resolveWorkbenchIndentation({ path: 'a.ts', detected, editorConfig: { indentStyle: 'tab', tabWidth: 8 } })
    ).toEqual({ style: 'tab', size: 8, tabSize: 8, source: 'editorconfig' })
    expect(
      resolveWorkbenchIndentation({ path: 'a.ts', detected: null, editorConfig: { indentSize: 3 } })
    ).toEqual({ style: 'space', size: 3, tabSize: 3, source: 'editorconfig' })
    expect(resolveWorkbenchIndentation({ path: 'tool.py', detected: null, editorConfig: null }).size).toBe(4)
    const makefile = resolveWorkbenchIndentation({ path: 'Makefile', detected: null, editorConfig: null })
    expect(workbenchIndentUnit(makefile)).toBe('\t')
    expect(workbenchIndentUnit(resolveWorkbenchIndentation({ path: 'a.ts', detected: null, editorConfig: null }))).toBe(
      '  '
    )
  })
})

describe('indentation chosen in the status bar', () => {
  test('overrides .editorconfig and the detected style', () => {
    expect(
      resolveWorkbenchIndentation({
        path: 'a.ts',
        detected: { style: 'space', size: 2 },
        editorConfig: { indentStyle: 'space', indentSize: 4 },
        override: { style: 'tab', size: 8 },
      })
    ).toEqual({ style: 'tab', size: 8, tabSize: 8, source: 'override' })
  })

  test('converts leading whitespace between spaces and tabs, keeping the columns', () => {
    const convert = (doc: string, style: 'space' | 'tab', size: number, tabSize: number) => {
      const state = EditorState.create({ doc })
      return state.update({ changes: buildWorkbenchIndentationConversion(state, { style, size }, tabSize) }).state.doc.toString()
    }
    expect(convert('a\n    b\n        c\n     d', 'tab', 4, 4)).toBe('a\n\tb\n\t\tc\n\t d')
    expect(convert('a\n\tb\n\t\tc\n\t  d', 'space', 4, 4)).toBe('a\n    b\n        c\n      d')
    expect(convert('x\n  y', 'space', 2, 2)).toBe('x\n  y')
  })
})
