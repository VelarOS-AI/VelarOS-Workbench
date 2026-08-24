import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import { getWorkbenchEditorZoomMenuCommand } from '../src/main/projects/WorkbenchEditorZoom'
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getWorkbenchEditorMetrics,
  getWorkbenchEditorZoomScale,
  getWorkbenchPreferencesStyle,
  getZoomedWorkbenchEditorZoomLevel,
  WORKBENCH_EDITOR_ZOOM_LEVEL_MAX,
  WORKBENCH_EDITOR_ZOOM_LEVEL_MIN,
} from '../src/renderer/src/models/settings/workbenchPreferences'

const baseInput = {
  alt: false,
  code: '',
  control: false,
  key: '',
  meta: false,
  type: 'keyDown',
}

void describe('Workbench editor zoom', () => {
  void test('maps Cmd/Ctrl zoom keys to editor commands only', () => {
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({ ...baseInput, key: '-', meta: true }),
      'zoom-editor-out'
    )
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({ ...baseInput, key: '=', control: true }),
      'zoom-editor-in'
    )
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({ ...baseInput, code: 'NumpadAdd', control: true }),
      'zoom-editor-in'
    )
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({ ...baseInput, key: '0', meta: true }),
      'zoom-editor-reset'
    )
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({ ...baseInput, key: '-', alt: true, meta: true }),
      null
    )
    assert.equal(getWorkbenchEditorZoomMenuCommand({ ...baseInput, key: '-' }), null)
    assert.equal(
      getWorkbenchEditorZoomMenuCommand({
        ...baseInput,
        key: '-',
        meta: true,
        type: 'keyUp',
      }),
      null
    )
  })

  void test('changes one proportional editor zoom level and clamps its bounds', () => {
    assert.equal(getZoomedWorkbenchEditorZoomLevel(0, 'increase'), 1)
    assert.equal(getZoomedWorkbenchEditorZoomLevel(0, 'decrease'), -1)
    assert.equal(getZoomedWorkbenchEditorZoomLevel(5, 'reset'), 0)
    assert.equal(
      getZoomedWorkbenchEditorZoomLevel(WORKBENCH_EDITOR_ZOOM_LEVEL_MAX, 'increase'),
      WORKBENCH_EDITOR_ZOOM_LEVEL_MAX
    )
    assert.equal(
      getZoomedWorkbenchEditorZoomLevel(WORKBENCH_EDITOR_ZOOM_LEVEL_MIN, 'decrease'),
      WORKBENCH_EDITOR_ZOOM_LEVEL_MIN
    )
  })

  void test('applies the same scale to code font size and line height', () => {
    const preferences = {
      ...DEFAULT_WORKBENCH_PREFERENCES,
      editorZoomLevel: 2,
    }
    const style = getWorkbenchPreferencesStyle(preferences) as Record<string, string>
    const scale = getWorkbenchEditorZoomScale(preferences.editorZoomLevel)
    const metrics = getWorkbenchEditorMetrics(preferences)

    assert.equal(style['--workbench-editor-font-size'], `${Math.round(12.5 * scale * 100) / 100}px`)
    assert.equal(style['--workbench-editor-line-height'], `${Math.round(20.25 * scale * 100) / 100}px`)
    assert.equal(metrics.fontSize, style['--workbench-editor-font-size'])
    assert.equal(metrics.lineHeight, style['--workbench-editor-line-height'])
  })

  void test('removes Electron page zoom roles and routes the focused window command', async () => {
    const [menuSource, windowSource, rendererSource, presentationSource, kernelSource] = await Promise.all([
      readFile('src/main/projects/ProjectHubMenu.ts', 'utf8'),
      readFile('src/main/projects/WorkbenchEditorZoom.ts', 'utf8'),
      readFile('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', 'utf8'),
      readFile('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx', 'utf8'),
      readFile('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx', 'utf8'),
    ])

    assert.doesNotMatch(menuSource, /role:\s*['"]viewMenu['"]/u)
    assert.doesNotMatch(menuSource, /role:\s*['"](?:resetZoom|zoomIn|zoomOut)['"]/u)
    assert.match(windowSource, /before-input-event/u)
    assert.match(windowSource, /event\.preventDefault\(\)/u)
    assert.match(windowSource, /setZoomFactor\(1\)/u)
    assert.match(rendererSource, /getZoomedWorkbenchEditorZoomLevel/u)
    assert.match(presentationSource, /editorStyle:\s*workbenchPreferences\.style/u)
    assert.match(kernelSource, /\.\.\.embeddedChrome\.editorStyle/u)
  })

  void test('scales the line-number gutter from the same editor font-size variable', async () => {
    const editorStyles = await readFile('src/renderer/src/styles/09-editor.module.css', 'utf8')

    assert.match(
      editorStyles,
      /\.cm-lineNumbers \.cm-gutterElement[\s\S]*font-size:\s*calc\(var\(--workbench-editor-font-size\)/u
    )
    assert.doesNotMatch(
      editorStyles,
      /\.cm-lineNumbers \.cm-gutterElement[\s\S]{0,320}font-size:\s*11\.5px/u
    )
  })

  void test('invalidates CodeMirror geometry and refreshes every editor surface', async () => {
    const [metricsSource, editorSource, diffSource, readOnlySource, editorStyles] =
      await Promise.all([
        readFile('src/renderer/src/models/editor/workbenchCodeMirrorMetrics.ts', 'utf8'),
        readFile('src/renderer/src/components/editor/CodeMirrorEditor.tsx', 'utf8'),
        readFile('src/renderer/src/components/editor/ReadOnlyDiffCodeMirror.tsx', 'utf8'),
        readFile('src/renderer/src/components/editor/ReadOnlyWorkbenchCode.tsx', 'utf8'),
        readFile('src/renderer/src/styles/09-editor.module.css', 'utf8'),
      ])

    assert.match(metricsSource, /compartment\.reconfigure/u)
    assert.match(metricsSource, /view\.requestMeasure/u)
    assert.match(metricsSource, /borderLeftWidth:\s*cursorWidth/u)
    assert.match(editorSource, /editorMetricsCompartment\.reconfigure/u)
    assert.match(editorSource, /workbench-editor-metrics-and-overlays/u)
    assert.match(editorSource, /setCommentDraft/u)
    assert.match(editorSource, /setRenamePopup/u)
    assert.match(diffSource, /refreshWorkbenchCodeMirrorMetrics/u)
    assert.match(readOnlySource, /refreshWorkbenchCodeMirrorMetrics/u)
    assert.match(editorStyles, /cm-workbenchMetricsRefreshing \.cm-selectionLayer/u)
    assert.match(editorStyles, /cm-workbenchMetricsRefreshing \.cm-cursorLayer/u)
  })
})
