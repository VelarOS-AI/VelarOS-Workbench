import { type Extension, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import type { WorkbenchLanguageServiceSemanticToken } from '@shared/contracts'

import { isWorkbenchDarkTheme, type WorkbenchThemeId } from '../settings/workbenchPreferences'

import { languageServiceRangeToOffsets } from './workbenchCodeMirrorLanguageService'

const semanticTokensRefreshEffect = StateEffect.define<void>()
const SemanticTokenDelayMs = 120
const markCache = new Map<string, Decoration>()

function semanticTokenTheme(dark: boolean): Extension {
  return EditorView.theme({
    '& .cm-workbenchSemantic-type, & .cm-workbenchSemantic-class, & .cm-workbenchSemantic-enum, & .cm-workbenchSemantic-enumMember': {
      color: `${dark ? '#56c3d6' : '#007070'} !important`,
    },
    '& .cm-workbenchSemantic-function, & .cm-workbenchSemantic-method': {
      color: `${dark ? '#dcdcaa' : '#795e26'} !important`,
    },
    '& .cm-workbenchSemantic-property': {
      color: `${dark ? '#bababa' : '#871094'} !important`,
    },
    '& .cm-workbenchSemantic-parameter, & .cm-workbenchSemantic-variable': {
      color: `${dark ? '#d8dee9' : '#000000'} !important`,
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

      constructor(private readonly view: EditorView) {
        void this.sync()
      }

      public update(update: ViewUpdate): void {
        if (!update.docChanged) return
        this.decorations = this.decorations.map(update.changes)
        this.schedule()
      }

      public destroy(): void {
        this.generation += 1
        if (this.timer) clearTimeout(this.timer)
      }

      private schedule(): void {
        this.generation += 1
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.sync()
        }, SemanticTokenDelayMs)
      }

      private async sync(): Promise<void> {
        const generation = ++this.generation
        const doc = this.view.state.doc
        let tokens: Nullable<readonly WorkbenchLanguageServiceSemanticToken[]>
        try {
          tokens = await runtime.request(doc.toString())
        } catch {
          return
        }
        if (generation !== this.generation || this.view.state.doc !== doc || !tokens) return
        this.decorations = buildWorkbenchSemanticTokenDecorations(doc.toString(), tokens)
        this.view.dispatch({ effects: semanticTokensRefreshEffect.of() })
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
