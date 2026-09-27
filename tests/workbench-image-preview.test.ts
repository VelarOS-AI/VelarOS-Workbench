import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchReadFileResult } from '@shared/contracts'
import {
  isWorkbenchImagePreviewPath,
  resolveWorkbenchImageMediaType,
} from '@shared/workbenchImage'

import {
  hasFileSnapshotChanged,
  isDirtyTab,
  toOpenedFileSnapshots,
} from '../src/renderer/src/models/editor/workbenchEditorTabs'
import {
  canStepWorkbenchImageZoom,
  clampWorkbenchImageManualZoom,
  formatWorkbenchImageZoom,
  resolveWorkbenchImageFitZoom,
  resolveWorkbenchImageWheelZoom,
  resolveWorkbenchImageZoomShortcut,
  stepWorkbenchImageZoom,
  WORKBENCH_IMAGE_MAX_MANUAL_ZOOM,
  WORKBENCH_IMAGE_MIN_MANUAL_ZOOM,
} from '../src/renderer/src/models/editor/workbenchImagePreview'
import type { WorkbenchOpenEditorTab } from '../src/renderer/src/types/workbenchTypes'

function createFile(
  path: string,
  content: string,
  options: Partial<WorkbenchReadFileResult> = {}
): WorkbenchReadFileResult {
  return {
    projectRoot: '/workspace/project',
    path,
    content,
    encoding: 'utf-8',
    eol: 'lf',
    size: content.length,
    modifiedAt: 123,
    totalLines: 1,
    truncated: false,
    ...options,
  }
}

void describe('Workbench image preview editor state', () => {
  void test('recognizes only the supported image extensions and media types', () => {
    assert.equal(resolveWorkbenchImageMediaType('assets/ICON.PNG'), 'image/png')
    assert.equal(resolveWorkbenchImageMediaType('attachment', 'image/svg+xml; charset=utf-8'), 'image/svg+xml')
    assert.equal(resolveWorkbenchImageMediaType('photo.webp'), 'image/webp')
    assert.equal(isWorkbenchImagePreviewPath('photo.jpeg'), false)
  })

  void test('keeps image tabs read-only and out of opened-file context snapshots', () => {
    const imageFile = createFile('assets/pixel.png', '', {
      size: 8,
      imagePreview: {
        mediaType: 'image/png',
        data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    })
    const imageTab: WorkbenchOpenEditorTab = {
      path: imageFile.path,
      file: imageFile,
      content: 'an editor mutation must not make an image dirty',
    }
    const textFile = createFile('src/main.ts', 'export const ready = true\n')
    const textTab: WorkbenchOpenEditorTab = {
      path: textFile.path,
      file: textFile,
      content: textFile.content,
    }

    assert.equal(isDirtyTab(imageTab), false)
    assert.equal(isDirtyTab({ ...textTab, content: `${textTab.content}// changed` }), true)
    assert.deepEqual(toOpenedFileSnapshots([imageTab, textTab]), [
      {
        path: 'src/main.ts',
        content: 'export const ready = true\n',
        language: 'TypeScript',
      },
    ])
  })

  void test('detects changed image bytes even when metadata and text placeholders match', () => {
    const current = createFile('assets/pixel.png', '', {
      size: 8,
      imagePreview: {
        mediaType: 'image/png',
        data: Uint8Array.from([1, 2, 3]),
      },
    })
    const unchanged = createFile('assets/pixel.png', '', {
      size: 8,
      imagePreview: {
        mediaType: 'image/png',
        data: Uint8Array.from([1, 2, 3]),
      },
    })
    const changed = createFile('assets/pixel.png', '', {
      size: 8,
      imagePreview: {
        mediaType: 'image/png',
        data: Uint8Array.from([1, 2, 4]),
      },
    })

    assert.equal(hasFileSnapshotChanged(current, unchanged), false)
    assert.equal(hasFileSnapshotChanged(current, changed), true)
  })

  void test('fits large images inside the available viewport without enlarging small images', () => {
    assert.equal(
      resolveWorkbenchImageFitZoom({
        naturalWidth: 2400,
        naturalHeight: 1600,
        viewportWidth: 1200,
        viewportHeight: 700,
      }),
      0.4375
    )
    assert.equal(
      resolveWorkbenchImageFitZoom({
        naturalWidth: 320,
        naturalHeight: 240,
        viewportWidth: 1200,
        viewportHeight: 700,
      }),
      1
    )
    assert.equal(
      resolveWorkbenchImageFitZoom({
        naturalWidth: 0,
        naturalHeight: 0,
        viewportWidth: 1200,
        viewportHeight: 700,
      }),
      1
    )
  })

  void test('steps manual image zoom through stable levels and clamps unsafe values', () => {
    assert.equal(stepWorkbenchImageZoom(1, 'in'), 1.25)
    assert.equal(stepWorkbenchImageZoom(1, 'out'), 0.75)
    assert.equal(stepWorkbenchImageZoom(0.4375, 'in'), 0.5)
    assert.equal(stepWorkbenchImageZoom(0.4375, 'out'), 0.33)
    assert.equal(stepWorkbenchImageZoom(WORKBENCH_IMAGE_MAX_MANUAL_ZOOM, 'in'), 8)
    assert.equal(stepWorkbenchImageZoom(WORKBENCH_IMAGE_MIN_MANUAL_ZOOM, 'out'), 0.1)
    assert.equal(canStepWorkbenchImageZoom(0.05, 'out'), false)
    assert.equal(canStepWorkbenchImageZoom(0.05, 'in'), true)
    assert.equal(canStepWorkbenchImageZoom(8, 'in'), false)
    assert.equal(clampWorkbenchImageManualZoom(Number.POSITIVE_INFINITY), 1)
    assert.equal(clampWorkbenchImageManualZoom(12), 8)
    assert.equal(clampWorkbenchImageManualZoom(0.01), 0.1)
  })

  void test('formats fit and manual zoom percentages without hiding very small fits', () => {
    assert.equal(formatWorkbenchImageZoom(1), '100%')
    assert.equal(formatWorkbenchImageZoom(0.4375), '44%')
    assert.equal(formatWorkbenchImageZoom(0.054), '5.4%')
  })

  void test('reserves plain preview shortcuts and modifier-wheel gestures for image zoom', () => {
    assert.equal(resolveWorkbenchImageZoomShortcut('+', false), 'in')
    assert.equal(resolveWorkbenchImageZoomShortcut('=', false), 'in')
    assert.equal(resolveWorkbenchImageZoomShortcut('-', false), 'out')
    assert.equal(resolveWorkbenchImageZoomShortcut('0', false), 'actual')
    assert.equal(resolveWorkbenchImageZoomShortcut('F', false), 'fit')
    assert.equal(resolveWorkbenchImageZoomShortcut('+', true), null)
    assert.equal(resolveWorkbenchImageZoomShortcut('ArrowRight', false), null)
    assert.equal(resolveWorkbenchImageWheelZoom(-1, true), 'in')
    assert.equal(resolveWorkbenchImageWheelZoom(1, true), 'out')
    assert.equal(resolveWorkbenchImageWheelZoom(1, false), null)
    assert.equal(resolveWorkbenchImageWheelZoom(0, true), null)
  })
})
