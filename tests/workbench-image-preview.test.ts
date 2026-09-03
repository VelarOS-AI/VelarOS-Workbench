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
})
