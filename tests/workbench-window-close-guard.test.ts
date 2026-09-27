import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  type WorkbenchCloseGuardedWindow,
  WorkbenchWindowCloseGuard,
} from '../src/main/projects/WorkbenchWindowCloseGuard'
import { collectWorkbenchEditorUnsavedAfterFlush } from '../src/renderer/src/models/editor/workbenchEditorTabClose'
import {
  WorkbenchWindowCloseChannels,
  type WorkbenchWindowCloseRequest,
} from '../src/shared/workbenchWindowClose'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

let nextWebContentsId = 1

class FakeWebContents extends EventEmitter {
  public readonly id = nextWebContentsId++
  public crashed = false
  public readonly requests: WorkbenchWindowCloseRequest[] = []

  public isCrashed(): boolean {
    return this.crashed
  }

  public isDestroyed(): boolean {
    return false
  }

  public send(channel: string, payload: WorkbenchWindowCloseRequest): void {
    assert.equal(channel, WorkbenchWindowCloseChannels.closeRequested)
    this.requests.push(payload)
  }
}

class FakeWindow extends EventEmitter {
  public readonly webContents = new FakeWebContents()
  public destroyed = false
  public documentEdited: Nullable<boolean> = null
  public focused = 0

  /** 像 BrowserWindow 一样：先发 close，没人拦就真的关掉。 */
  public close(): void {
    let prevented = false
    this.emit('close', { preventDefault: () => (prevented = true) })
    if (prevented) return
    this.destroyed = true
    this.emit('closed')
  }

  public focus(): void {
    this.focused += 1
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public isMinimized(): boolean {
    return false
  }

  public isVisible(): boolean {
    return true
  }

  public restore(): void {}

  public setDocumentEdited(edited: boolean): void {
    this.documentEdited = edited
  }

  public show(): void {}
}

function createGuard(platform: NodeJS.Platform = 'darwin') {
  let quits = 0
  const guard = new WorkbenchWindowCloseGuard(() => {
    quits += 1
  }, platform)
  const install = (): FakeWindow => {
    const window = new FakeWindow()
    guard.install(window as unknown as WorkbenchCloseGuardedWindow)
    return window
  }
  return { guard, install, quits: () => quits }
}

void describe('closing a window with unsaved editor changes', () => {
  void test('a window without unsaved changes closes at once', () => {
    const { install } = createGuard()
    const window = install()

    window.close()
    assert.equal(window.destroyed, true)
    assert.deepEqual(window.webContents.requests, [])
  })

  void test('asks the renderer first and closes only after it agrees', () => {
    const { guard, install } = createGuard()
    const window = install()
    guard.setUnsavedChanges(window.webContents.id, true)
    assert.equal(window.documentEdited, true)

    window.close()
    assert.equal(window.destroyed, false)
    assert.deepEqual(window.webContents.requests, [{ id: 1, reason: 'close' }])

    // 确认框还开着时又点了一次关闭：不重复问。
    window.close()
    assert.equal(window.webContents.requests.length, 1)

    // 过期的答复不算数。
    guard.resolveCloseRequest(window.webContents.id, { id: 99, proceed: true })
    assert.equal(window.destroyed, false)

    guard.resolveCloseRequest(window.webContents.id, { id: 1, proceed: true })
    assert.equal(window.destroyed, true)
  })

  void test('cancelling keeps the window open and asks again next time', () => {
    const { guard, install } = createGuard()
    const window = install()
    guard.setUnsavedChanges(window.webContents.id, true)

    window.close()
    guard.resolveCloseRequest(window.webContents.id, { id: 1, proceed: false })
    assert.equal(window.destroyed, false)

    window.close()
    assert.deepEqual(window.webContents.requests.at(-1), { id: 2, reason: 'close' })
  })

  void test('quitting asks every window with changes before any cleanup, and a cancel stops the quit', () => {
    const { guard, install, quits } = createGuard()
    const first = install()
    const second = install()
    const clean = install()
    guard.setUnsavedChanges(first.webContents.id, true)
    guard.setUnsavedChanges(second.webContents.id, true)

    assert.equal(guard.holdQuit(), true)
    assert.deepEqual(first.webContents.requests, [{ id: 1, reason: 'quit' }])
    // 第一个窗口答应了：接着走退出，下一轮问第二个。
    guard.resolveCloseRequest(first.webContents.id, { id: 1, proceed: true })
    assert.equal(quits(), 1)
    assert.equal(guard.holdQuit(), true)
    assert.deepEqual(second.webContents.requests, [{ id: 2, reason: 'quit' }])

    // 第二个取消：退出作罢，第一个的同意也收回，之后关它还得再问。
    guard.resolveCloseRequest(second.webContents.id, { id: 2, proceed: false })
    assert.equal(quits(), 1)
    first.close()
    assert.equal(first.destroyed, false)
    assert.equal(first.webContents.requests.at(-1)?.reason, 'close')
    assert.deepEqual(clean.webContents.requests, [])
  })

  void test('once every window agreed the quit goes ahead and windows close freely', () => {
    const { guard, install, quits } = createGuard()
    const window = install()
    guard.setUnsavedChanges(window.webContents.id, true)

    assert.equal(guard.holdQuit(), true)
    guard.resolveCloseRequest(window.webContents.id, { id: 1, proceed: true })
    assert.equal(quits(), 1)
    assert.equal(guard.holdQuit(), false)

    // 退出流程里又报了一次有改动（还在打字）：不再拦，卸载时的同步保存兜底。
    guard.setUnsavedChanges(window.webContents.id, true)
    window.close()
    assert.equal(window.destroyed, true)
  })

  void test('a crashed renderer or a reloaded page never blocks closing', () => {
    const { guard, install } = createGuard('linux')
    const crashed = install()
    guard.setUnsavedChanges(crashed.webContents.id, true)
    crashed.webContents.crashed = true
    crashed.close()
    assert.equal(crashed.destroyed, true)
    // 只有 macOS 在关闭按钮上标改动。
    assert.equal(crashed.documentEdited, null)

    const reloaded = install()
    guard.setUnsavedChanges(reloaded.webContents.id, true)
    reloaded.close()
    assert.equal(reloaded.destroyed, false)
    reloaded.webContents.emit('did-navigate')
    reloaded.close()
    assert.equal(reloaded.destroyed, true)
  })

  void test('only files still unsaved after the silent flush are put to the user', () => {
    assert.deepEqual(
      collectWorkbenchEditorUnsavedAfterFlush(
        ['saved.ts', 'clean.ts', 'conflict.ts', 'failed.ts', 'deleted.ts'],
        new Map([
          ['saved.ts', 'saved'],
          ['clean.ts', 'skipped'],
          ['conflict.ts', 'conflict'],
          ['failed.ts', 'failed'],
        ] as const)
      ),
      ['conflict.ts', 'failed.ts', 'deleted.ts']
    )
  })

  void test('main holds the quit before tearing anything down and the renderer answers', () => {
    const main = readSource('src/main/index.ts')
    const preload = readSource('src/preload/index.ts')
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')

    assert.match(main, /installWorkbenchWindowState\(window\)\n\s*windowCloseGuard\.install\(window\)/u)
    assert.match(main, /registerWorkbenchWindowCloseIpc\(windowCloseGuard\)/u)
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"))
    assert.ok(
      beforeQuit.indexOf('windowCloseGuard.holdQuit()') < beforeQuit.indexOf('shutdownStarted = true')
    )
    assert.match(preload, /exposeInMainWorld\('velarosWorkbenchWindowClose', windowCloseBridge\)/u)
    assert.match(pageModel, /setUnsavedChanges\(hasUnsavedOpenTabs\)/u)
    assert.match(pageModel, /onCloseRequested\([\s\S]*?confirmWindowClose\(request\.reason\)[\s\S]*?resolveCloseRequest\(\{ id: request\.id, proceed \}\)/u)
    // 不保存：放弃改动，页面卸载时也不再替它们写回去。
    assert.match(controller, /skipExitFlush\(dirtyTabs\)\n\s*revertOpenFiles\(/u)
    assert.match(controller, /saveEditorTabs\(dirtyTabs\.filter\(isWorkbenchEditorTabAutosavable\)\)/u)
  })
})
