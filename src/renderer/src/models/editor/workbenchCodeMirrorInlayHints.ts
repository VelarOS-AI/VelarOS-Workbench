import type { ChangeDesc, Extension, Text } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'

import { isBlank, isNumber, Log } from '@velaros-ai/velaros/core'
import { type TimerLease, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import {
  type WorkbenchLanguageServiceInlayHint,
  type WorkbenchLanguageServiceOffsetRange,
} from '@shared/contracts/workbench'

const InitialInlayHintDelayMs = 180
const ChangedDocumentInlayHintDelayMs = 320
const ScrolledViewportInlayHintDelayMs = 80
const InlayHintViewportBufferLines = 30
const MaxCachedInlayHintDocuments = 50
const MaxCachedDocumentLength = 256 * 1024
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
  content: string
  ranges: readonly WorkbenchLanguageServiceOffsetRange[]
  hints: readonly WorkbenchLanguageServiceInlayHint[]
}

const inlayHintCache = new Map<string, WorkbenchInlayHintCacheEntry>()

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
  content: string,
  ranges: readonly WorkbenchLanguageServiceOffsetRange[]
): Nullable<readonly WorkbenchLanguageServiceInlayHint[]> {
  const entry = inlayHintCache.get(cacheKey)
  if (!entry || entry.content !== content || !cacheCoversRanges(entry.ranges, ranges)) return null

  inlayHintCache.delete(cacheKey)
  inlayHintCache.set(cacheKey, entry)
  return entry.hints
}

function cacheWorkbenchInlayHints(cacheKey: string, entry: WorkbenchInlayHintCacheEntry): void {
  inlayHintCache.delete(cacheKey)
  if (entry.content.length > MaxCachedDocumentLength) return
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

export function mapWorkbenchInlayHintDecorationsThroughChanges(
  decorations: DecorationSet,
  previousDoc: Text,
  changes: ChangeDesc
): DecorationSet {
  let retained = decorations
  changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    const lineStart = previousDoc.lineAt(from).from
    const lastLine = previousDoc.lineAt(to)
    const removesWholeLines =
      from < to && lineStart === from && lastLine.from === to && nextFrom === nextTo
    const lineEnd = removesWholeLines ? to - 1 : lastLine.to
    retained = retained.update({
      filterFrom: lineStart,
      filterTo: lineEnd,
      filter: (position) => position < lineStart || position > lineEnd,
    })
  })
  return retained.map(changes)
}

const workbenchInlayHintsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWorkbenchInlayHintsEffect))
        return buildWorkbenchInlayHintDecorations(transaction.state.doc.length, effect.value)
    }

    return transaction.docChanged && decorations.size > 0
      ? mapWorkbenchInlayHintDecorationsThroughChanges(
          decorations,
          transaction.startState.doc,
          transaction.changes
        )
      : decorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

function buildWorkbenchInlayHintLoader(runtime: WorkbenchInlayHintRuntime): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly timers = new TimerScope({ name: 'WorkbenchInlayHintLoader' })
      private timer: Nullable<TimerLease> = null
      private generation = 0
      private documentRefreshNotBefore = 0
      private pointerSelection: AbortController | null = null
      private pendingHints: {
        generation: number
        hints: readonly WorkbenchLanguageServiceInlayHint[]
      } | null = null

      constructor(private readonly view: EditorView) {
        this.timer = this.timers.after(
          0,
          () => {
            this.timer = null
            if (!this.restoreCached()) this.schedule(InitialInlayHintDelayMs)
          },
          {
            label: 'workbench.inlayHints.restoreCached',
          }
        )
      }

      public update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.documentRefreshNotBefore = performance.now() + ChangedDocumentInlayHintDelayMs
          this.schedule(ChangedDocumentInlayHintDelayMs)
        } else if (update.viewportMoved) {
          // Caret/layout changes can change the viewport on the frame after typing.
          // They must not replace the post-edit pause with the shorter scroll delay.
          this.schedule(
            Math.max(
              ScrolledViewportInlayHintDelayMs,
              this.documentRefreshNotBefore - performance.now()
            )
          )
        }
      }

      public startPointerSelection(event: MouseEvent): void {
        if (event.button !== 0 || this.pointerSelection) return
        this.pointerSelection = new AbortController()
        const options = { signal: this.pointerSelection.signal }
        const owner = this.view.contentDOM.ownerDocument
        owner.addEventListener(
          'mouseup',
          (event) => {
            if (event.button === 0) this.finishPointerSelection()
          },
          options
        )
        owner.addEventListener('dragend', this.finishPointerSelection, options)
        owner.defaultView?.addEventListener('blur', this.finishPointerSelection, options)
      }

      private readonly finishPointerSelection = (): void => {
        this.pointerSelection?.abort()
        this.pointerSelection = null
        const pending = this.pendingHints
        this.pendingHints = null
        if (pending) {
          // Let CodeMirror finish handling the mouse gesture before changing character geometry.
          this.timers.after(0, () => this.presentHints(pending.generation, pending.hints), {
            label: 'workbench.inlayHints.afterPointerSelection',
          })
        }
      }

      private presentHints(
        generation: number,
        hints: readonly WorkbenchLanguageServiceInlayHint[]
      ): void {
        if (generation !== this.generation) return
        if (this.pointerSelection) this.pendingHints = { generation, hints }
        else this.view.dispatch({ effects: setWorkbenchInlayHintsEffect.of(hints) })
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
        const ranges = buildWorkbenchInlayHintViewportRanges(this.view)
        const cached = readCachedWorkbenchInlayHints(runtime.cacheKey, content, ranges)

        try {
          const hints = cached ?? (await runtime.request(content, ranges))
          if (generation !== this.generation) return

          if (!cached) {
            cacheWorkbenchInlayHints(runtime.cacheKey, { content, ranges, hints })
          }
          this.presentHints(generation, hints)
        } catch (error) {
          log.debug('failed to load inferred type hints', { error })
        }
      }

      private restoreCached(): boolean {
        const content = this.view.state.doc.toString()
        const ranges = buildWorkbenchInlayHintViewportRanges(this.view)
        const hints = readCachedWorkbenchInlayHints(runtime.cacheKey, content, ranges)
        if (hints) this.presentHints(this.generation, hints)
        return hints !== null
      }

      public destroy(): void {
        this.generation += 1
        this.timer = null
        this.pointerSelection?.abort()
        this.pendingHints = null
        this.timers.dispose()
      }
    },
    {
      eventObservers: {
        mousedown(event) {
          this.startPointerSelection(event)
        },
      },
    }
  )
}

export function createWorkbenchInlayHintExtension(runtime: WorkbenchInlayHintRuntime): Extension {
  return [workbenchInlayHintsField, buildWorkbenchInlayHintLoader(runtime)]
}
