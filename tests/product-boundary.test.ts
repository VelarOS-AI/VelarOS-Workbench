import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { WorkbenchRuntime } from '../src/renderer/src/composition/WorkbenchRuntime'
import {
  installWorkbenchHost,
  type WorkbenchHost,
  workbenchHost,
  WorkbenchHostRuntime,
} from '../src/renderer/src/host/WorkbenchHost'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitCommitDraft,
  buildWorkbenchGitDecorationMap,
} from '../src/renderer/src/models/git/workbenchGitModel'
import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import { saveLightEditorTab } from '../src/renderer/src/models/lightEditorModel'
import {
  normalizeWorkbenchProjectRootPath,
  readWorkbenchProjects,
} from '../src/renderer/src/models/project/workbenchProjects'
import { WorkbenchCommentStore } from '../src/renderer/src/models/workbenchCommentStore'
import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../src/renderer/src/support/localStorageJsonStore'
import type { WorkbenchLightEditorTab } from '../src/renderer/src/types/workbenchTypes'

function createHost(marker: string): WorkbenchHost {
  return {
    kernel: {
      project: { marker },
      workspace: {},
    },
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

void describe('Workbench product boundary', () => {
  void test('standalone host can replace its concrete transport adapter', () => {
    const first = createHost('first')
    const second = createHost('second')
    installWorkbenchHost(first)
    installWorkbenchHost(second)

    assert.equal(workbenchHost.kernel, second.kernel)
  })

  void test('isolated host runtimes guard install and teardown ownership', () => {
    const runtime = new WorkbenchHostRuntime()
    const first = createHost('first')
    const second = createHost('second')

    assert.throws(() => runtime.kernel, /not installed/)
    runtime.install(first)
    runtime.install(second)
    assert.equal(runtime.kernel, second.kernel)
    assert.equal(runtime.uninstall(first), false)
    assert.equal(runtime.uninstall(second), true)
    assert.equal(runtime.isInstalled, false)
  })

  void test('composition runtimes own isolated host and comment state', () => {
    const first = new WorkbenchRuntime({
      host: createHost('first'),
      comments: { createId: () => 'first-comment', now: () => 1 },
    })
    const second = new WorkbenchRuntime({
      host: createHost('second'),
      comments: { createId: () => 'second-comment', now: () => 2 },
    })

    first.comments.add({
      projectRoot: '/first',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 1,
      snippet: 'a',
      body: 'first',
      language: 'ts',
    })

    assert.equal((first.host.kernel.project as { marker: string }).marker, 'first')
    assert.equal((second.host.kernel.project as { marker: string }).marker, 'second')
    assert.equal(first.comments.getSnapshot().length, 1)
    assert.equal(second.comments.getSnapshot().length, 0)

    first.dispose()
    assert.equal(first.host.isInstalled, false)
    assert.throws(
      () =>
        first.comments.add({
          projectRoot: '/first',
          path: 'src/b.ts',
          startLine: 1,
          endLine: 1,
          snippet: 'b',
          body: 'disposed',
          language: 'ts',
        }),
      /disposed/
    )
    second.dispose()
  })

  void test('comment stores isolate listeners and bind methods', () => {
    const first = new WorkbenchCommentStore({ createId: () => 'one', now: () => 10 })
    const second = new WorkbenchCommentStore({ createId: () => 'two', now: () => 20 })
    let firstChanges = 0
    const unsubscribe = first.subscribe(() => {
      firstChanges += 1
    })
    const add = first.add

    add({
      projectRoot: '/project',
      path: 'index.ts',
      startLine: 1,
      endLine: 2,
      snippet: 'const value = 1',
      body: 'rename this',
      language: 'ts',
    })

    assert.equal(firstChanges, 1)
    assert.equal(first.get('one')?.createdAt, 10)
    assert.equal(second.getSnapshot().length, 0)
    unsubscribe()
    first.dispose()
    second.dispose()
  })

  void test('JSON stores own normalization and injected storage lifecycle', () => {
    const storage = createMemoryStorage()
    const store = createLocalStorageJsonStore<number>({
      key: 'count',
      fallback: 0,
      normalize: (value) => Number(value) || 0,
      storage,
    })

    assert.equal(store.read(), 0)
    assert.equal(
      store.update((value) => value + 2),
      2
    )
    assert.equal(store.read(), 2)
    store.remove()
    assert.equal(store.read(), 0)
  })

  void test('JSON factory methods stay bound when passed as callbacks', () => {
    const storage = createMemoryStorage()
    const { read, write } = createLocalStorageJsonStore({
      key: 'bound-count',
      fallback: 0,
      storage,
    })
    write(3)
    assert.equal(read(), 3)
  })

  void test('project persistence imports existing identities without rewriting local storage', () => {
    const storage = createMemoryStorage()
    const roots = ['/workspace/velaros', '/', 'C:\\']
    const projects = roots.map((root, index) => {
      assert.equal(normalizeWorkbenchProjectRootPath(root), root)
      return {
        id: `project-${index}`,
        name: root,
        rootPath: root,
        createdAt: 42,
        lastOpenedAt: null,
        pinned: false,
      }
    })
    const source = JSON.stringify(projects)
    storage.setItem('velaros.workbench.projects.v1', source)
    assert.deepEqual(readWorkbenchProjects(storage), projects)
    assert.equal(storage.getItem('velaros.workbench.projects.v1'), source)
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

    assert.deepEqual(
      items.map((item) => item.group),
      ['unstaged', 'untracked']
    )
    const decoration = buildWorkbenchGitDecorationMap(items).get('src')
    assert.equal(decoration?.isDirectory, true)
    assert.equal(decoration?.tone, 'modified')
    assert.equal(
      buildWorkbenchGitCommitDraft([items[1]], (key, params) =>
        translateWorkbenchAppMessage('zh-CN', key, params)
      ),
      '添加 README.md'
    )
  })

  void test('project image previews remain read-only', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const tab: WorkbenchLightEditorTab = {
      id: '/project\0sample.png',
      projectRoot: '/project',
      path: 'sample.png',
      content: '',
      size: bytes.length,
      modifiedAt: 123,
      totalLines: 1,
      truncated: false,
      imagePreview: { mediaType: 'image/png', data: bytes },
    }

    let invoked = false
    await assert.rejects(
      saveLightEditorTab(tab, {
        saveWorkbenchFile: async () => {
          invoked = true
          throw new Error('unexpected save')
        },
      }),
      // 测试环境里读不到界面语言（没有 localStorage、navigator.language），按英文出。
      /read-only preview cannot be saved as plain text|只读预览不能作为纯文本保存/
    )
    assert.equal(invoked, false)
  })
})
