import type { Extension, Text } from '@codemirror/state'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

import { resolveWorkbenchEditorLanguage } from '../../language/workbenchEditorLanguageContributions'

export const WORKBENCH_JAVASCRIPT_KEYWORDS = [
  'accessor',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'defer',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'using',
  'var',
  'void',
  'while',
  'with',
  'yield',
] as const

export const WORKBENCH_TYPESCRIPT_KEYWORDS = [
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
  'abstract',
  'accessor',
  'as',
  'asserts',
  'assert',
  'any',
  'async',
  'await',
  'boolean',
  'constructor',
  'declare',
  'get',
  'infer',
  'intrinsic',
  'is',
  'keyof',
  'module',
  'namespace',
  'never',
  'out',
  'readonly',
  'require',
  'number',
  'object',
  'satisfies',
  'set',
  'string',
  'symbol',
  'type',
  'undefined',
  'unique',
  'unknown',
  'using',
  'from',
  'global',
  'bigint',
  'override',
  'of',
  'defer',
] as const

function keywordPattern(keywords: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'g')
}

const JavaScriptKeywordPattern = keywordPattern(WORKBENCH_JAVASCRIPT_KEYWORDS)
const TypeScriptKeywordPattern = keywordPattern(WORKBENCH_TYPESCRIPT_KEYWORDS)
const PythonKeywordPattern =
  /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/g
const JsonKeywordPattern = /\b(?:false|null|true)\b/g
const JavaScriptLanguageIds = new Set(['javascript', 'js', 'jsx', 'mjs', 'cjs'])
const TypeScriptLanguageIds = new Set([
  'typescript',
  'ts',
  'tsx',
  'mts',
  'cts',
])
const JavaScriptFamilyLanguageIds = new Set([
  ...JavaScriptLanguageIds,
  ...TypeScriptLanguageIds,
])

const basicKeywordTheme = EditorView.baseTheme({
  '.cm-workbenchBasicKeyword': {
    color: 'var(--workbench-editor-hover-keyword, #0033b3) !important',
  },
})

function keywordPatternFor(languageId: string): Nullable<RegExp> {
  const normalized = languageId.trim().toLowerCase()
  const injected = resolveWorkbenchEditorLanguage(normalized)?.basicSyntax
  if (injected) {
    const keywords = injected.keywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    return new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'g')
  }
  if (JavaScriptLanguageIds.has(normalized)) return JavaScriptKeywordPattern
  if (TypeScriptLanguageIds.has(normalized)) return TypeScriptKeywordPattern
  if (['python', 'py', 'pyi'].includes(normalized)) return PythonKeywordPattern
  if (['json', 'jsonc'].includes(normalized)) return JsonKeywordPattern
  return null
}

function isCodePosition(lineText: string, position: number, languageId: string): boolean {
  let quote: Nullable<string> = null
  let escaped = false
  const hashComments = ['py', 'pyi', 'python'].includes(languageId.trim().toLowerCase())
  const injectedLineComment = resolveWorkbenchEditorLanguage(languageId)?.basicSyntax?.lineComment

  for (let index = 0; index < position; index += 1) {
    const char = lineText[index]
    const next = lineText[index + 1]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if ((injectedLineComment === '//' || !injectedLineComment) && char === '/' && next === '/')
      return false
    if (injectedLineComment === '#' && char === '#') return false
    if (hashComments && char === '#') return false
    if (char === '"' || char === "'" || char === '`') quote = char
  }

  return !quote
}

export function getWorkbenchJavaScriptKeywordRangeAtPosition(
  doc: Text,
  position: number,
  languageId: string
): Nullable<{ from: number; to: number }> {
  const normalizedLanguage = languageId.trim().toLowerCase()
  if (!JavaScriptFamilyLanguageIds.has(normalizedLanguage)) return null

  const offset = Math.min(Math.max(0, position), doc.length)
  const line = doc.lineAt(offset)
  const sourcePattern = keywordPatternFor(normalizedLanguage)
  if (!sourcePattern) return null
  const pattern = new RegExp(sourcePattern.source, sourcePattern.flags)
  for (const match of line.text.matchAll(pattern)) {
    const index = match.index ?? 0
    const from = line.from + index
    const to = from + match[0].length
    if (offset < from || offset > to) continue
    if (!isCodePosition(line.text, index, normalizedLanguage)) return null
    return { from, to }
  }

  return null
}

export function buildWorkbenchBasicKeywordDecorations(
  doc: Text,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  languageId: string
): DecorationSet {
  const sourcePattern = keywordPatternFor(languageId)
  if (!sourcePattern) return Decoration.none

  const builder = new RangeSetBuilder<Decoration>()
  const visitedLines = new Set<number>()

  for (const visibleRange of visibleRanges) {
    let line = doc.lineAt(visibleRange.from)
    while (line.from <= visibleRange.to) {
      if (!visitedLines.has(line.number)) {
        visitedLines.add(line.number)
        const pattern = new RegExp(sourcePattern.source, sourcePattern.flags)
        for (const match of line.text.matchAll(pattern)) {
          const index = match.index ?? 0
          if (!isCodePosition(line.text, index, languageId)) continue
          builder.add(
            line.from + index,
            line.from + index + match[0].length,
            Decoration.mark({ class: 'cm-workbenchBasicKeyword' })
          )
        }
      }

      if (line.to >= doc.length) break
      line = doc.line(line.number + 1)
    }
  }

  return builder.finish()
}

export function createWorkbenchBasicSyntaxExtension(languageId: string): Extension {
  return [
    basicKeywordTheme,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet

        constructor(view: EditorView) {
          this.decorations = this.build(view)
        }

        public update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged)
            this.decorations = this.build(update.view)
        }

        private build(view: EditorView): DecorationSet {
          return buildWorkbenchBasicKeywordDecorations(
            view.state.doc,
            view.visibleRanges,
            languageId
          )
        }
      },
      { decorations: (plugin) => plugin.decorations }
    ),
  ]
}
