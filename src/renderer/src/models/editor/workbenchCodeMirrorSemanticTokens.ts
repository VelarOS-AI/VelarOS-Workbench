import { type Extension, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { WorkbenchLanguageServiceSemanticToken } from '@shared/contracts'

import { isWorkbenchDarkTheme, type WorkbenchThemeId } from '../settings/workbenchPreferences'

import { languageServiceRangeToOffsets } from './workbenchCodeMirrorLanguageService'

const semanticTokensRefreshEffect = StateEffect.define<void>()
const SemanticTokenDelayMs = 120
const SemanticTokenRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000] as const
const markCache = new Map<string, Decoration>()

function semanticTokenTheme(dark: boolean): Extension {
  return EditorView.theme({
    '& .cm-workbenchSemantic-namespace, & .cm-workbenchSemantic-type, & .cm-workbenchSemantic-class, & .cm-workbenchSemantic-interface, & .cm-workbenchSemantic-struct, & .cm-workbenchSemantic-typeParameter': {
      color: `${dark ? '#4ec9b0' : '#007f73'} !important`,
    },
    '& .cm-workbenchSemantic-enum': {
      color: `${dark ? '#4ec9b0' : '#007f73'} !important`,
    },
    '& .cm-workbenchSemantic-enumMember': {
      color: `${dark ? '#4fc1ff' : '#0070c1'} !important`,
    },
    '& .cm-workbenchSemantic-keyword, & .cm-workbenchSemantic-keyword *': {
      color: `${dark ? '#c586c0' : '#af00db'} !important`,
    },
    '& .cm-workbenchSemantic-function, & .cm-workbenchSemantic-method': {
      color: `${dark ? '#ffd580' : '#a04b00'} !important`,
    },
    '& .cm-workbenchSemantic-property, & .cm-workbenchSemantic-event': {
      color: `${dark ? '#e394dc' : '#a31574'} !important`,
    },
    '& .cm-workbenchSemantic-parameter': {
      color: `${dark ? '#8ecbff' : '#005fb8'} !important`,
    },
    '& .cm-workbenchSemantic-variable': {
      color: `${dark ? '#d8dee9' : '#202124'} !important`,
    },
    '& .cm-workbenchSemantic-macro, & .cm-workbenchSemantic-decorator': {
      color: `${dark ? '#c8a56c' : '#808000'} !important`,
    },
    '& .cm-workbenchSemanticModifier-deprecated': {
      textDecoration: 'line-through',
    },
    '& .cm-workbenchSemanticModifier-readonly': {
      fontStyle: 'normal',
    },
    '& .cm-workbenchSemantic-variable.cm-workbenchSemanticModifier-readonly': {
      color: `${dark ? '#62c8ff' : '#0067c0'} !important`,
    },
  })
}

export function getWorkbenchSemanticTokenTheme(theme: WorkbenchThemeId): Extension {
  return semanticTokenTheme(isWorkbenchDarkTheme(theme))
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

export function buildWorkbenchSemanticTokenDecorations(
  content: string,
  tokens: readonly WorkbenchLanguageServiceSemanticToken[]
): DecorationSet {
  const ranges = tokens.slice(0, 10_000).flatMap((token) => {
    const range = languageServiceRangeToOffsets(content, token.range)
    return range && range.from < range.to ? [{ ...range, mark: markFor(token) }] : []
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
