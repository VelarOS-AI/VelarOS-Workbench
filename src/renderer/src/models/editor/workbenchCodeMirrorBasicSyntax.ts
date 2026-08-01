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

const JavaScriptKeywordPattern =
  /\b(?:as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|keyof|let|namespace|never|new|null|of|private|protected|public|readonly|return|satisfies|set|static|string|super|switch|symbol|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|with|yield)\b/g
const PythonKeywordPattern =
  /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/g
const JsonKeywordPattern = /\b(?:false|null|true)\b/g

const basicKeywordTheme = EditorView.baseTheme({
  '.cm-workbenchBasicKeyword': {
    color: 'var(--workbench-editor-hover-keyword, #0033b3)',
  },
})

function keywordPatternFor(languageId: string): Nullable<RegExp> {
  const normalized = languageId.trim().toLowerCase()
  const injected = resolveWorkbenchEditorLanguage(normalized)?.basicSyntax
  if (injected) {
    const keywords = injected.keywords.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    return new RegExp(`\\b(?:${keywords.join('|')})\\b`, 'g')
  }
  if (
    ['javascript', 'js', 'jsx', 'typescript', 'ts', 'tsx', 'mts', 'cts', 'mjs', 'cjs'].includes(
      normalized
    )
  )
    return JavaScriptKeywordPattern
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
