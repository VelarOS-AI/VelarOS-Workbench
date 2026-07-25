import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { SystemLocalAttachmentFileResult } from '@velaros-ai/core/types'

import {
  installWorkbenchHost,
  type WorkbenchHost,
  workbenchHost,
} from '../packages/workbench/src/host/WorkbenchHost'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitCommitDraft,
  buildWorkbenchGitDecorationMap,
} from '../packages/workbench/src/models/git/workbenchGitModel'
import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
} from '../packages/workbench/src/models/layout/workbenchKeyboardShortcuts'
import {
  buildLightEditorTab,
  resolveOfficePreviewKind,
  saveLightEditorTab,
} from '../packages/workbench/src/models/lightEditorModel'
import {
  createWorkbenchProject,
  readWorkbenchProjects,
  saveWorkbenchProjects,
} from '../packages/workbench/src/models/project/workbenchProjects'
import type { StorageLike } from '../packages/workbench/src/persistence/localStorageJsonStore'

function createHost(marker: string): WorkbenchHost {
  return {
    kernel: {
      project: { marker },
      sessions: {},
      settings: {},
      workspace: {},
    },
    shell: {},
  } as unknown as WorkbenchHost
}

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function createLocalFile(
  path: string,
  data: Uint8Array,
  mediaType = 'application/octet-stream'
): SystemLocalAttachmentFileResult {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    mediaType,
    size: data.byteLength,
    lastModified: 123,
    data,
  }
}

void describe('Workbench product boundary', () => {
  void test('standalone host can replace its concrete transport adapter', () => {
    const first = createHost('first')
    const second = createHost('second')
    installWorkbenchHost(first)
    installWorkbenchHost(second)

    assert.equal(workbenchHost.kernel, second.kernel)
    assert.equal(workbenchHost.shell, second.shell)
  })

  void test('project persistence is owned by the product model', () => {
    const storage = createMemoryStorage()
    const project = createWorkbenchProject('/workspace/velaros', 42)
    saveWorkbenchProjects([project], storage)
    assert.deepEqual(readWorkbenchProjects(storage), [project])
  })

  void test('keyboard conflicts stay inside the product model', () => {
    assert.deepEqual(
      buildWorkbenchKeymapConflicts({
        ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
        'quick-open': 'Mod+K',
        'save-current': 'mod+k',
      }),
      [{ shortcut: 'mod+k', actions: ['quick-open', 'save-current'] }]
    )
  })

  void test('Git changes produce directory decorations and localized commit text', () => {
    const items = buildWorkbenchGitChangeItems([
      { path: 'src/workbench.ts', indexStatus: ' ', workTreeStatus: 'M' },
      { path: 'README.md', indexStatus: '?', workTreeStatus: '?' },
    ])

    assert.deepEqual(items.map((item) => item.group), ['unstaged', 'untracked'])
    const decoration = buildWorkbenchGitDecorationMap(items).get('src')
    assert.equal(decoration?.isDirectory, true)
    assert.equal(decoration?.tone, 'modified')
    assert.equal(buildWorkbenchGitCommitDraft([items[1]], 'zh-CN'), '添加 README.md')
  })

  void test('Office files remain read-only binary previews', async () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 255])
    const tab = buildLightEditorTab(createLocalFile('/tmp/sample.pptx', bytes))

    assert.equal(resolveOfficePreviewKind('/tmp/sample.pptx'), 'pptx')
    assert.equal(tab.content, '')
    assert.equal(tab.officePreview?.kind, 'pptx')

    let invoked = false
    await assert.rejects(
      saveLightEditorTab(tab, {
        saveWorkbenchFile: async () => {
          invoked = true
          throw new Error('unexpected save')
        },
        writeLocalAttachmentFile: async () => {
          invoked = true
          throw new Error('unexpected save')
        },
      }),
      /Office 预览为只读内容/
    )
    assert.equal(invoked, false)
  })
})
