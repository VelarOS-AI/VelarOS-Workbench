import { type Extension, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { WorkbenchLanguageServiceSemanticToken } from '@shared/contracts'

import type { WorkbenchThemeId } from '../settings/workbenchPreferences'

import { languageServiceRangeToOffsets } from './workbenchCodeMirrorLanguageService'
import { getWorkbenchCodeTokenPalette } from './workbenchCodeMirrorTheme'

const semanticTokensRefreshEffect = StateEffect.define<void>()
const SemanticTokenDelayMs = 450
const SemanticTokenRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000] as const
const markCache = new Map<string, Decoration>()
const SemanticBuiltinTypeNames = new Set([
  'Error',
  'List',
  'Map',
  'Promise',
  'Set',
])
const SemanticKeywordTypeNames = new Set([
  'any',
  'bigint',
  'bool',
  'boolean',
  'intrinsic',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'undefined',
  'unknown',
  'void',
])
const SemanticTypeTokenKinds = new Set([
  'class',
  'enum',
  'interface',
  'namespace',
  'struct',
  'type',
  'typeParameter',
])
const SemanticBuiltinOwnerTokenKinds = new Set([
  'class',
  'interface',
  'namespace',
  'type',
  'variable',
])

function semanticTokenTheme(theme: WorkbenchThemeId): Extension {
  const palette = getWorkbenchCodeTokenPalette(theme)
  return EditorView.theme({
    '& .cm-workbenchSemantic-namespace, & .cm-workbenchSemantic-namespace *, & .cm-workbenchSemantic-type, & .cm-workbenchSemantic-type *, & .cm-workbenchSemantic-class, & .cm-workbenchSemantic-class *, & .cm-workbenchSemantic-interface, & .cm-workbenchSemantic-interface *, & .cm-workbenchSemantic-struct, & .cm-workbenchSemantic-struct *, & .cm-workbenchSemantic-typeParameter, & .cm-workbenchSemantic-typeParameter *': {
      color: `${palette.type} !important`,
    },
    '& .cm-workbenchSemantic-enum, & .cm-workbenchSemantic-enum *': {
      color: `${palette.type} !important`,
    },
    '& .cm-workbenchSemantic-builtinType, & .cm-workbenchSemantic-builtinType *': {
      color: `${palette.type} !important`,
    },
    '& .cm-workbenchSemantic-enumMember, & .cm-workbenchSemantic-enumMember *': {
      color: `${palette.property} !important`,
    },
    '& .cm-workbenchSemantic-frameworkDefinition, & .cm-workbenchSemantic-frameworkDefinition *': {
      color: `${palette.frameworkDefinition} !important`,
    },
    '& .cm-workbenchSemantic-keyword, & .cm-workbenchSemantic-keyword *': {
      color: `${palette.keyword} !important`,
    },
    '& .cm-workbenchSemantic-function, & .cm-workbenchSemantic-function *, & .cm-workbenchSemantic-method, & .cm-workbenchSemantic-method *': {
      color: `${palette.function} !important`,
    },
    '& .cm-workbenchSemantic-property, & .cm-workbenchSemantic-property *, & .cm-workbenchSemantic-event, & .cm-workbenchSemantic-event *': {
      color: `${palette.property} !important`,
    },
    '& .cm-workbenchSemantic-parameter, & .cm-workbenchSemantic-parameter *': {
      color: `${palette.variable} !important`,
    },
    '& .cm-workbenchSemantic-variable, & .cm-workbenchSemantic-variable *': {
      color: `${palette.variable} !important`,
    },
    '& .cm-workbenchSemantic-macro, & .cm-workbenchSemantic-macro *, & .cm-workbenchSemantic-decorator, & .cm-workbenchSemantic-decorator *': {
      color: `${palette.decorator} !important`,
    },
    '& .cm-workbenchSemanticModifier-deprecated': {
      textDecoration: 'line-through',
    },
    '& .cm-workbenchSemanticModifier-readonly': {
      fontStyle: 'normal',
    },
  })
}

export function getWorkbenchSemanticTokenTheme(theme: WorkbenchThemeId): Extension {
  return semanticTokenTheme(theme)
}

export interface WorkbenchSemanticTokensRuntime {
  request: (content: string) => Promise<Nullable<readonly WorkbenchLanguageServiceSemanticToken[]>>
}

function safeClassSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/gu, '-')
}

function markFor(token: WorkbenchLanguageServiceSemanticToken): Decoration {
  const classes = [
    `cm-workbenchSemantic-${safeClassSegment(token.type)}`,
    ...token.modifiers.map((modifier) => `cm-workbenchSemanticModifier-${safeClassSegment(modifier)}`),
  ].join(' ')
  const current = markCache.get(classes)
  if (current) return current
  const mark = Decoration.mark({ class: classes })
  markCache.set(classes, mark)
  return mark
}

function adjacentNonWhitespace(
  content: string,
  offset: number,
  direction: -1 | 1
): string {
  let index = direction < 0 ? offset - 1 : offset
  while (index >= 0 && index < content.length) {
    const character = content[index] ?? ''
    if (!/\s/u.test(character)) return character
    index += direction
  }
  return ''
}

function isObjectShorthandRange(content: string, from: number, to: number): boolean {
  const before = adjacentNonWhitespace(content, from, -1)
  const after = adjacentNonWhitespace(content, to, 1)
  return (before === '{' || before === ',') && (after === ',' || after === '}')
}

export function buildWorkbenchSemanticTokenDecorations(
  content: string,
  tokens: readonly WorkbenchLanguageServiceSemanticToken[]
): DecorationSet {
  const callableNames = new Set(
    tokens.flatMap((token) => {
      if (token.type !== 'function' && token.type !== 'method') return []
      const range = languageServiceRangeToOffsets(content, token.range)
      return range ? [content.slice(range.from, range.to)] : []
    })
  )
  const ranges = tokens.slice(0, 10_000).flatMap((token) => {
    const range = languageServiceRangeToOffsets(content, token.range)
    if (!range || range.from >= range.to) return []

    const tokenText = content.slice(range.from, range.to)
    let effectiveToken = token
    if (token.modifiers.includes('frameworkDefinition')) {
      effectiveToken = { ...token, type: 'frameworkDefinition' }
    } else if (
      SemanticTypeTokenKinds.has(token.type)
      && SemanticKeywordTypeNames.has(tokenText)
    ) {
      effectiveToken = { ...token, type: 'keyword' }
    } else if (
      (
        SemanticBuiltinOwnerTokenKinds.has(token.type)
        && token.modifiers.includes('defaultLibrary')
      ) || (
        SemanticTypeTokenKinds.has(token.type)
        && SemanticBuiltinTypeNames.has(tokenText)
      )
    ) {
      effectiveToken = { ...token, type: 'builtinType' }
    } else if (
      token.type === 'property'
      && callableNames.has(tokenText)
      && isObjectShorthandRange(content, range.from, range.to)
    ) {
      effectiveToken = { ...token, type: 'function' }
    }
    return [{ ...range, mark: markFor(effectiveToken) }]
  }).sort((left, right) => left.from - right.from || left.to - right.to)
  return Decoration.set(ranges.map((range) => range.mark.range(range.from, range.to)), true)
}

export function createWorkbenchSemanticTokensExtension(runtime: WorkbenchSemanticTokensRuntime): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private generation = 0
      private timer: Nullable<ReturnType<typeof setTimeout>> = null
      private retryAttempt = 0
      private destroyed = false

      constructor(private readonly view: EditorView) {
        void this.sync()
      }

      public update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes)
          this.retryAttempt = 0
          this.schedule()
          return
        }
        if ((update.focusChanged && update.view.hasFocus) || update.viewportChanged) {
          if (this.decorations === Decoration.none) this.schedule(0)
        }
      }

      public destroy(): void {
        this.destroyed = true
        this.generation += 1
        if (this.timer) clearTimeout(this.timer)
      }

      private schedule(delayMs = SemanticTokenDelayMs): void {
        if (this.destroyed) return
        this.generation += 1
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.sync()
        }, delayMs)
      }

      private retry(): void {
        const delay = SemanticTokenRetryDelaysMs[this.retryAttempt]
        if (delay === undefined || this.destroyed) return
        this.retryAttempt += 1
        this.schedule(delay)
      }

      private async sync(): Promise<void> {
        const generation = ++this.generation
        const doc = this.view.state.doc
        let tokens: Nullable<readonly WorkbenchLanguageServiceSemanticToken[]>
        try {
          tokens = await runtime.request(doc.toString())
        } catch {
          if (generation === this.generation) this.retry()
          return
        }
        if (generation !== this.generation || this.view.state.doc !== doc) return
        if (!tokens) {
          this.retry()
          return
        }
        this.retryAttempt = 0
        this.decorations = buildWorkbenchSemanticTokenDecorations(doc.toString(), tokens)
        this.view.dispatch({ effects: semanticTokensRefreshEffect.of() })
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
