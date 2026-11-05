import { type Diagnostic, forEachDiagnostic, setDiagnosticsEffect } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { isEmpty } from '@velaros-ai/velaros/core'

export interface WorkbenchDiagnosticOverviewLineMarker {
  line: number
  severity: Diagnostic['severity']
}

const DIAGNOSTIC_OVERVIEW_SEVERITY_RANK: Record<Diagnostic['severity'], number> = {
  error: 4,
  warning: 3,
  info: 2,
  hint: 1,
}

function diagnosticOverviewSeverityRank(severity: Diagnostic['severity']): number {
  return DIAGNOSTIC_OVERVIEW_SEVERITY_RANK[severity]
}

export function shouldShowWorkbenchDiagnosticInOverview(
  diagnostic: Pick<Diagnostic, 'severity' | 'markClass'>
): boolean {
  const markClass = diagnostic.markClass?.trim() ?? ''
  if (markClass.includes('cm-workbenchUnusedVariable')) return false
  return true
}

export function mergeWorkbenchDiagnosticOverviewEntries(
  entries: ReadonlyArray<{
    line: number
    severity: Diagnostic['severity']
    markClass?: string
  }>
): WorkbenchDiagnosticOverviewLineMarker[] {
  const byLine = new Map<number, Diagnostic['severity']>()

  for (const entry of entries) {
    if (!shouldShowWorkbenchDiagnosticInOverview(entry)) continue

    const existing = byLine.get(entry.line)
    if (
      !existing ||
      diagnosticOverviewSeverityRank(entry.severity) > diagnosticOverviewSeverityRank(existing)
    ) {
      byLine.set(entry.line, entry.severity)
    }
  }

  return [...byLine.entries()]
    .map(([line, severity]) => ({ line, severity }))
    .sort((left, right) => left.line - right.line)
}

function collectOverviewLineMarkersFromView(
  view: EditorView
): WorkbenchDiagnosticOverviewLineMarker[] {
  const entries: Array<{
    line: number
    severity: Diagnostic['severity']
    markClass?: string
  }> = []

  forEachDiagnostic(view.state, (diagnostic, from) => {
    entries.push({
      line: view.state.doc.lineAt(from).number,
      severity: diagnostic.severity,
      markClass: diagnostic.markClass,
    })
  })

  return mergeWorkbenchDiagnosticOverviewEntries(entries)
}

/** Fixed overview marker height in px — thin horizontal stripe, not line-block tall. */
export const WORKBENCH_DIAGNOSTIC_OVERVIEW_BAR_HEIGHT_PX = 7

export interface WorkbenchDiagnosticOverviewBarLayout {
  topPercent: number
}

export function computeWorkbenchDiagnosticOverviewBarLayout(
  lineBlockTop: number,
  lineBlockHeight: number,
  contentHeight: number,
  barHeightPx: number = WORKBENCH_DIAGNOSTIC_OVERVIEW_BAR_HEIGHT_PX
): WorkbenchDiagnosticOverviewBarLayout {
  if (contentHeight <= 0) return { topPercent: 0 }

  const lineCenter = lineBlockTop + lineBlockHeight / 2
  const topPx = Math.max(0, lineCenter - barHeightPx / 2)

  return {
    topPercent: (topPx / contentHeight) * 100,
  }
}

function overviewMarkerBarLayout(
  view: EditorView,
  lineNumber: number,
  contentHeight: number
): WorkbenchDiagnosticOverviewBarLayout {
  const linePos = view.state.doc.line(lineNumber).from
  const block = view.lineBlockAt(linePos)
  return computeWorkbenchDiagnosticOverviewBarLayout(block.top, block.height, contentHeight)
}

function renderOverviewMarkers(
  view: EditorView,
  track: HTMLElement,
  markers: readonly WorkbenchDiagnosticOverviewLineMarker[]
): void {
  const contentHeight = view.contentHeight
  if (contentHeight <= 0 || isEmpty(markers)) {
    track.replaceChildren()
    return
  }

  const fragments = markers.map((marker) => {
    const bar = document.createElement('div')
    bar.className = `cm-workbenchDiagnosticOverviewMark cm-workbenchDiagnosticOverviewMark-${marker.severity}`
    const layout = overviewMarkerBarLayout(view, marker.line, contentHeight)
    bar.style.top = `${layout.topPercent}%`
    bar.style.height = `${WORKBENCH_DIAGNOSTIC_OVERVIEW_BAR_HEIGHT_PX}px`
    return bar
  })

  track.replaceChildren(...fragments)
}

function overviewNeedsSync(update: ViewUpdate): boolean {
  if (update.docChanged || update.geometryChanged) return true

  return update.transactions.some((transaction) =>
    transaction.effects.some((effect) => effect.is(setDiagnosticsEffect))
  )
}

export function createWorkbenchDiagnosticOverviewExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly track: HTMLElement

      constructor(private readonly view: EditorView) {
        this.track = document.createElement('div')
        this.track.className = 'cm-workbenchDiagnosticOverview'
        this.track.setAttribute('aria-hidden', 'true')
        view.dom.appendChild(this.track)
        this.sync()
      }

      public update(update: ViewUpdate): void {
        if (overviewNeedsSync(update)) {
          this.sync()
        }
      }

      public destroy(): void {
        this.track.remove()
      }

      private sync(): void {
        renderOverviewMarkers(this.view, this.track, collectOverviewLineMarkersFromView(this.view))
      }
    }
  )
}
