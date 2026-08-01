import type { Extension } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import { isBlank,isNumber, Log } from '@velaros-ai/core'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type {
  WorkbenchLanguageServiceInlayHint,
  WorkbenchLanguageServiceOffsetRange,
} from '../../contracts/index'

const InitialInlayHintDelayMs = 180
const ChangedDocumentInlayHintDelayMs = 320
const ScrolledViewportInlayHintDelayMs = 80
const InlayHintViewportBufferLines = 30
const MaxCachedInlayHintDocuments = 50
const MaxRenderedInlayHints = 1500
const log = Log.tag('workbench-codemirror-inlay-hints')

export interface WorkbenchInlayHintRuntime {
  cacheKey: string
  request: (
    content: string,
    ranges: readonly WorkbenchLanguageServiceOffsetRange[]
  ) => Promise<readonly WorkbenchLanguageServiceInlayHint[]>
}

interface WorkbenchInlayHintCacheEntry {
  fingerprint: string
  ranges: readonly WorkbenchLanguageServiceOffsetRange[]
  hints: readonly WorkbenchLanguageServiceInlayHint[]
}

const inlayHintCache = new Map<string, WorkbenchInlayHintCacheEntry>()

function fingerprintWorkbenchInlayHintContent(content: string): string {
  let hash = content.length | 0
  const stride = Math.max(1, Math.floor(content.length / 64))
  for (let index = 0; index < content.length; index += stride) {
    hash = Math.imul(hash ^ content.charCodeAt(index), 16_777_619)
  }
  return `${content.length}:${hash >>> 0}`
}

function cacheCoversRanges(
  cached: readonly WorkbenchLanguageServiceOffsetRange[],
  requested: readonly WorkbenchLanguageServiceOffsetRange[]
): boolean {
  return requested.every((range) =>
    cached.some((candidate) => candidate.from <= range.from && candidate.to >= range.to)
  )
}

function readCachedWorkbenchInlayHints(
  cacheKey: string,
  fingerprint: string,
  ranges: readonly WorkbenchLanguageServiceOffsetRange[]
): Nullable<readonly WorkbenchLanguageServiceInlayHint[]> {
  const entry = inlayHintCache.get(cacheKey)
  if (!entry || entry.fingerprint !== fingerprint || !cacheCoversRanges(entry.ranges, ranges))
    return null

  inlayHintCache.delete(cacheKey)
  inlayHintCache.set(cacheKey, entry)
  return entry.hints
}

function cacheWorkbenchInlayHints(cacheKey: string, entry: WorkbenchInlayHintCacheEntry): void {
  inlayHintCache.delete(cacheKey)
  inlayHintCache.set(cacheKey, entry)
  while (inlayHintCache.size > MaxCachedInlayHintDocuments) {
    const oldestKey = inlayHintCache.keys().next().value
    if (!oldestKey) break
    inlayHintCache.delete(oldestKey)
  }
}

export function buildWorkbenchInlayHintViewportRanges(
  view: EditorView
): WorkbenchLanguageServiceOffsetRange[] {
  const ranges: WorkbenchLanguageServiceOffsetRange[] = []

  for (const visibleRange of view.visibleRanges) {
    const startLine = Math.max(
      1,
      view.state.doc.lineAt(visibleRange.from).number - InlayHintViewportBufferLines
    )
    const endLine = Math.min(
      view.state.doc.lines,
      view.state.doc.lineAt(visibleRange.to).number + InlayHintViewportBufferLines
    )
    const range = {
      from: view.state.doc.line(startLine).from,
      to: Math.min(view.state.doc.length, view.state.doc.line(endLine).to + 1),
    }
    const previous = ranges[ranges.length - 1]
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      ranges.push(range)
    }
  }

  return ranges
}

class WorkbenchInlayHintWidget extends WidgetType {
  constructor(private readonly hint: WorkbenchLanguageServiceInlayHint) {
    super()
  }

  public eq(other: WorkbenchInlayHintWidget): boolean {
    return (
      other.hint.text === this.hint.text &&
      other.hint.whitespaceBefore === this.hint.whitespaceBefore &&
      other.hint.whitespaceAfter === this.hint.whitespaceAfter
    )
  }

  public toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-workbenchInlayTypeHint'
    span.textContent = `${this.hint.whitespaceBefore ? ' ' : ''}${this.hint.text}${
      this.hint.whitespaceAfter ? ' ' : ''
    }`
    span.setAttribute('aria-hidden', 'true')
    span.setAttribute('draggable', 'false')
    const blockInteraction = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    for (const eventName of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      span.addEventListener(eventName, blockInteraction)
    }
    return span
  }

  public ignoreEvent(): boolean {
    return true
  }
}

export function buildWorkbenchInlayHintDecorations(
  docLength: number,
  hints: readonly WorkbenchLanguageServiceInlayHint[]
): DecorationSet {
  const ranges = hints
    .filter((hint) => isNumber(hint.position.offset) && !isBlank(hint.text))
    .map((hint) => ({
      hint,
      position: Math.min(Math.max(0, hint.position.offset!), docLength),
    }))
    .sort((left, right) => left.position - right.position)
    .slice(0, MaxRenderedInlayHints)
    .map(({ hint, position }) =>
      Decoration.widget({
        widget: new WorkbenchInlayHintWidget(hint),
        side: 1,
      }).range(position)
    )

  return Decoration.set(ranges, true)
}

const setWorkbenchInlayHintsEffect =
  StateEffect.define<readonly WorkbenchLanguageServiceInlayHint[]>()

const workbenchInlayHintsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWorkbenchInlayHintsEffect))
        return buildWorkbenchInlayHintDecorations(transaction.state.doc.length, effect.value)
    }

    return transaction.docChanged ? Decoration.none : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

function buildWorkbenchInlayHintLoader(runtime: WorkbenchInlayHintRuntime): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly timers = new TimerScope({ name: 'WorkbenchInlayHintLoader' })
      private timer: Nullable<TimerLease> = null
      private generation = 0

      constructor(private readonly view: EditorView) {
        this.timers.after(0, () => this.restoreCached(), {
          label: 'workbench.inlayHints.restoreCached',
        })
        this.schedule(InitialInlayHintDelayMs)
      }

      public update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.schedule(ChangedDocumentInlayHintDelayMs)
        } else if (update.viewportChanged) {
          this.schedule(ScrolledViewportInlayHintDelayMs)
        }
      }

      private schedule(delay: number): void {
        this.timer?.cancel()
        const generation = ++this.generation
        this.timer = this.timers.after(
          delay,
          () => {
            this.timer = null
            void this.load(generation)
          },
          { label: 'workbench.inlayHints.load' }
        )
      }

      private async load(generation: number): Promise<void> {
        const content = this.view.state.doc.toString()
        const fingerprint = fingerprintWorkbenchInlayHintContent(content)
        const ranges = buildWorkbenchInlayHintViewportRanges(this.view)
        const cached = readCachedWorkbenchInlayHints(runtime.cacheKey, fingerprint, ranges)

        try {
          const hints = cached ?? (await runtime.request(content, ranges))
          if (generation !== this.generation) return

          if (!cached) {
            cacheWorkbenchInlayHints(runtime.cacheKey, { fingerprint, ranges, hints })
          }
          this.view.dispatch({ effects: setWorkbenchInlayHintsEffect.of(hints) })
        } catch (error) {
          log.debug('failed to load inferred type hints', { error })
        }
      }

      private restoreCached(): void {
        const content = this.view.state.doc.toString()
        const ranges = buildWorkbenchInlayHintViewportRanges(this.view)
        const hints = readCachedWorkbenchInlayHints(
          runtime.cacheKey,
          fingerprintWorkbenchInlayHintContent(content),
          ranges
        )
        if (hints) this.view.dispatch({ effects: setWorkbenchInlayHintsEffect.of(hints) })
      }

      public destroy(): void {
        this.generation += 1
        this.timer = null
        this.timers.dispose()
      }
    }
  )
}

export function createWorkbenchInlayHintExtension(runtime: WorkbenchInlayHintRuntime): Extension {
  return [workbenchInlayHintsField, buildWorkbenchInlayHintLoader(runtime)]
}
