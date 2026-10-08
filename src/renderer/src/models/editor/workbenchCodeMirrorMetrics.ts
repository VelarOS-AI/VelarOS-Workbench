import type { Compartment, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { WorkbenchEditorMetrics } from '../workbenchPreferences'

/**
 * CodeMirror 会缓存字符宽度、文本高度和行块位置。仅改变外层 CSS 变量时，
 * 文字可能先重绘，而合成光标/选区仍短暂沿用旧缓存。把最终尺寸直接放进
 * 可重配主题，能让 CodeMirror 在同一次更新里失效并重测这些几何数据。
 */
export function createWorkbenchCodeMirrorMetricsExtension(
  metrics: WorkbenchEditorMetrics
): Extension {
  const fontSize = Number.parseFloat(metrics.fontSize)
  const cursorWidth = `${Math.round(Math.max(1, fontSize * 0.24) * 100) / 100}px`

  return EditorView.theme({
    '&': {
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
    },
    '.cm-scroller': {
      lineHeight: metrics.lineHeight,
    },
    '.cm-gutters': {
      fontSize: metrics.fontSize,
      lineHeight: metrics.lineHeight,
    },
    '.cm-cursor': {
      borderLeftWidth: cursorWidth,
    },
  })
}

/** 同步刷新不带 React 浮层的 CodeMirror 实例。 */
export function refreshWorkbenchCodeMirrorMetrics(
  view: EditorView,
  compartment: Compartment,
  metrics: WorkbenchEditorMetrics
): void {
  view.dom.classList.add('cm-workbenchMetricsRefreshing')
  view.dispatch({
    effects: compartment.reconfigure(createWorkbenchCodeMirrorMetricsExtension(metrics)),
  })
  view.requestMeasure({
    key: 'workbench-editor-metrics',
    read: () => undefined,
    write: () => view.dom.classList.remove('cm-workbenchMetricsRefreshing'),
  })
}
