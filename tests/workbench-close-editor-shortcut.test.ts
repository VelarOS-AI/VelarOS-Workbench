import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'
import type { BrowserWindow } from 'electron'

import { WorkbenchProjectHubChannels } from '../src/shared/projectHub'

// 窗口管理器只在取焦点窗口、弹目录选择框时才碰 electron；这里给它一个空壳。
mock.module('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {},
}))

class FakeProjectWindow extends EventEmitter {
  private static nextId = 100
  public readonly sent: Array<{ channel: string; payload: unknown }> = []
  public readonly webContents = {
    id: FakeProjectWindow.nextId++,
    isDestroyed: () => false,
    isLoading: () => false,
    send: (channel: string, payload: unknown): void => {
      if (channel === WorkbenchProjectHubChannels.menuCommand) this.sent.push({ channel, payload })
    },
  }

  public isDestroyed(): boolean {
    return false
  }
}

function readSource(relativePath: string): Promise<string> {
  return readFile(relativePath, 'utf8')
}

void describe('Cmd/Ctrl+W closes the editor tab, Shift closes the window', () => {
  void test('the close-editor command only goes to the window that triggered the menu', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-close-editor-'))
    const { WorkbenchWindowManager } = await import('../src/main/projects/WorkbenchWindowManager')
    try {
      const created: FakeProjectWindow[] = []
      const windows = new WorkbenchWindowManager(dataRoot, {
        createBrowserWindow: () => {
          const window = new FakeProjectWindow()
          created.push(window)
          return window as unknown as BrowserWindow
        },
      })
      const first = windows.createWindow() as unknown as FakeProjectWindow
      const second = windows.createWindow() as unknown as FakeProjectWindow

      windows.sendMenuCommandToWindow(second as unknown as BrowserWindow, 'close-editor')
      assert.deepEqual(second.sent, [
        { channel: WorkbenchProjectHubChannels.menuCommand, payload: 'close-editor' },
      ])
      assert.deepEqual(first.sent, [])

      // 没有焦点窗口（或是不认识的窗口）：什么也不做，更不会为此新开一个窗口。
      windows.sendMenuCommandToWindow(null, 'close-editor')
      windows.sendMenuCommandToWindow(new FakeProjectWindow() as unknown as BrowserWindow, 'close-editor')
      assert.equal(created.length, 2)
      assert.equal(first.sent.length + second.sent.length, 1)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('the menu binds Cmd/Ctrl+W to the editor tab and Shift+Cmd/Ctrl+W to the window', async () => {
    const menu = await readSource('src/main/projects/ProjectHubMenu.ts')

    assert.match(
      menu,
      /accelerator: 'CmdOrCtrl\+W',[\s\S]*?sendMenuCommandToWindow\(window \?\? null, 'close-editor'\)/u
    )
    assert.match(menu, /accelerator: 'CmdOrCtrl\+Shift\+W',[\s\S]*?window\?\.close\(\)/u)
    // 内置的 windowMenu 在 Windows / Linux 上带着 Ctrl+W 的「关闭」：不再使用，也不留任何 close 角色。
    assert.doesNotMatch(menu, /role: 'windowMenu'|role: 'close'/u)
    assert.match(menu, /role: 'window',[\s\S]*?role: 'minimize'/u)
  })

  void test('the renderer closes whatever tab is in front, and nothing when there is none', async () => {
    const [pageModel, adapter, editorPanel] = await Promise.all([
      readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx'),
      readSource('src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts'),
      readSource('src/renderer/src/components/editor/EditorPanel.tsx'),
    ])

    assert.match(
      pageModel,
      /case 'close-editor': \{[\s\S]*?setCloseActiveEditorTabRequestId\(\(requestId\) => requestId \+ 1\)/u
    )
    assert.match(adapter, /closeActiveTabRequestId: model\.closeActiveEditorTabRequestId/u)
    const closeActive = editorPanel.slice(
      editorPanel.indexOf('function closeActiveEditorTab'),
      editorPanel.indexOf('const handledCloseActiveTabRequestIdRef')
    )
    // 与画面一致的前台顺序；最后才是普通文件标签，没有选中的文件就什么也不做。
    const order = [
      'setFileHistoryMode(null)',
      'activeAuxiliaryTab.onClose?.()',
      'onCloseDiffTab?.()',
      'lightTab.onClose()',
      // 固定标签不随 ⌘W 关掉。
      'if (selectedFilePath && !selectedTabPinned) onCloseOpenFile(selectedFilePath)',
    ].map((snippet) => closeActive.indexOf(snippet))
    assert.ok(order.every((index) => index >= 0), String(order))
    assert.deepEqual([...order].sort((left, right) => left - right), order)
    assert.match(
      editorPanel,
      /handledCloseActiveTabRequestIdRef\.current === closeActiveTabRequestId\) return[\s\S]*?closeActiveEditorTab\(\)/u
    )
  })
})
