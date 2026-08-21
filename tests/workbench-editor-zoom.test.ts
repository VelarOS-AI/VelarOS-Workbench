import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import { getWorkbenchEditorZoomMenuCommand } from '../src/main/projects/WorkbenchEditorZoom'
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getZoomedWorkbenchEditorFontSize,
  WORKBENCH_EDITOR_FONT_SIZE_MAX,
  WORKBENCH_EDITOR_FONT_SIZE_MIN,
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

  void test('changes only the editor font-size scale and clamps its bounds', () => {
    assert.equal(getZoomedWorkbenchEditorFontSize(12.5, 'increase'), 13)
    assert.equal(getZoomedWorkbenchEditorFontSize(12.5, 'decrease'), 12)
    assert.equal(
      getZoomedWorkbenchEditorFontSize(16, 'reset'),
      DEFAULT_WORKBENCH_PREFERENCES.editorFontSize
    )
    assert.equal(
      getZoomedWorkbenchEditorFontSize(WORKBENCH_EDITOR_FONT_SIZE_MAX, 'increase'),
      WORKBENCH_EDITOR_FONT_SIZE_MAX
    )
    assert.equal(
      getZoomedWorkbenchEditorFontSize(WORKBENCH_EDITOR_FONT_SIZE_MIN, 'decrease'),
      WORKBENCH_EDITOR_FONT_SIZE_MIN
    )
  })

  void test('removes Electron page zoom roles and routes the focused window command', async () => {
    const [menuSource, windowSource, rendererSource] = await Promise.all([
      readFile('src/main/projects/ProjectHubMenu.ts', 'utf8'),
      readFile('src/main/projects/WorkbenchEditorZoom.ts', 'utf8'),
      readFile('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', 'utf8'),
    ])

    assert.doesNotMatch(menuSource, /role:\s*['"]viewMenu['"]/u)
    assert.doesNotMatch(menuSource, /role:\s*['"](?:resetZoom|zoomIn|zoomOut)['"]/u)
    assert.match(windowSource, /before-input-event/u)
    assert.match(windowSource, /event\.preventDefault\(\)/u)
    assert.match(windowSource, /setZoomFactor\(1\)/u)
    assert.match(rendererSource, /getZoomedWorkbenchEditorFontSize/u)
  })
})
