import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'bun:test'
import type { BrowserWindow, WebContents } from 'electron'

import { WorkbenchHistoryWindows } from '../src/main/projects/WorkbenchHistoryWindows'
import { WorkbenchHistoryWindowChannels as channels } from '../src/shared/workbenchHistoryWindow'

class HistoryTestWindow extends EventEmitter {
  private static sequence = 1000
  destroyed = false
  minimized = false
  focused = false
  messages: Array<[string, unknown]> = []
  webContents = Object.assign(new EventEmitter(), {
    id: HistoryTestWindow.sequence++,
    isDestroyed: () => this.destroyed,
    send: (channel: string, message: unknown) => this.messages.push([channel, message]),
  })
  public isDestroyed(): boolean {
    return this.destroyed
  }
  public isMinimized(): boolean {
    return this.minimized
  }
  public restore(): void {
    this.minimized = false
  }
  public show(): void {}
  public focus(): void {
    this.focused = true
  }
  public close(): void {
    this.destroyed = true
    this.emit('closed')
  }
  public window(): BrowserWindow {
    return this as unknown as BrowserWindow
  }
  public sender(): WebContents {
    return this.webContents as unknown as WebContents
  }
}

const file = {
  projectRoot: '/project',
  path: 'main.ts',
  mode: 'local' as const,
  currentContent: 'current',
  editable: true,
}
function fixture() {
  const owner = new HistoryTestWindow()
  const children: HistoryTestWindow[] = []
  const controller = new WorkbenchHistoryWindows({
    windows: {
      getWindowForWebContents: (sender) =>
        sender.id === owner.sender().id || children.some((child) => child.sender().id === sender.id)
          ? owner.window()
          : null,
      assertProjectForWebContents: (_sender, root) => {
        if (root !== '/project') throw new Error('Foreign project')
      },
      registerAuxiliaryWindow: (_sender, window) => {
        owner.once('closed', () => window.close())
      },
    },
    createWindow: () => {
      const child = new HistoryTestWindow()
      children.push(child)
      return child.window()
    },
    loadWindow: (window) => {
      window.emit('ready-to-show')
    },
  })
  controller.open(owner.sender(), file)
  return { owner, child: children[0]!, children, controller }
}

void test('history reuses one owned native window and denies unrelated or auxiliary senders', () => {
  const { owner, child, children, controller } = fixture()
  const first = controller.getState(child.sender())
  child.minimized = true
  controller.open(owner.sender(), { ...file, path: 'other.ts', mode: 'git' })
  assert.equal(children.length, 1)
  assert.equal(child.minimized, false)
  assert.equal(child.focused, true)
  assert.equal(controller.getState(child.sender()).path, 'other.ts')
  assert.notEqual(controller.getState(child.sender()).id, first.id)
  assert.throws(() => controller.open(child.sender(), file), /project editor window/)
  assert.throws(
    () => controller.open(owner.sender(), { ...file, projectRoot: '/foreign' }),
    /Foreign project/
  )
  assert.throws(() => controller.getState(owner.sender()), /Not a history window/)
  assert.throws(() => controller.getState(new HistoryTestWindow().sender()), /Not a history window/)
  controller.dispose()
})

void test('history restore is acknowledged only by its editor owner and binds the original path', async () => {
  const { owner, child, controller } = fixture()
  const state = controller.getState(child.sender())
  const restoring = controller.restore(child.sender(), {
    id: state.id,
    expectedContent: 'current',
    content: 'historic',
  })
  const [channel, message] = owner.messages.at(-1)! as [
    string,
    { requestId: string; path: string; content: string },
  ]
  assert.equal(channel, channels.restoreRequested)
  assert.equal(message.path, 'main.ts')
  assert.equal(message.content, 'historic')
  controller.resolveRestore(new HistoryTestWindow().sender(), {
    requestId: message.requestId,
    result: { ok: true },
  })
  assert.deepEqual(
    await controller.restore(child.sender(), {
      id: state.id,
      expectedContent: 'current',
      content: 'another',
    }),
    { ok: false, reason: 'unavailable' }
  )
  controller.resolveRestore(owner.sender(), { requestId: message.requestId, result: { ok: true } })
  assert.deepEqual(await restoring, { ok: true })
  assert.equal(owner.focused, true)
  controller.dispose()
})

void test('stale, closed and readonly drafts are never overwritten', async () => {
  const { owner, child, controller } = fixture()
  const state = controller.getState(child.sender())
  const restore = () =>
    controller.restore(child.sender(), {
      id: state.id,
      expectedContent: 'current',
      content: 'historic',
    })
  controller.synchronize(owner.sender(), {
    id: state.id,
    currentContent: 'new draft',
    editable: true,
  })
  assert.deepEqual(await restore(), { ok: false, reason: 'stale' })
  controller.synchronize(owner.sender(), {
    id: state.id,
    currentContent: 'current',
    editable: false,
  })
  assert.deepEqual(await restore(), { ok: false, reason: 'read-only' })
  controller.synchronize(owner.sender(), { id: state.id, currentContent: null, editable: false })
  assert.deepEqual(await restore(), { ok: false, reason: 'closed' })
  controller.synchronize(owner.sender(), {
    id: 'old-window-id',
    currentContent: 'other',
    editable: true,
  })
  assert.equal(controller.getState(child.sender()).available, false)
  assert.equal(
    owner.messages.filter(([channel]) => channel === channels.restoreRequested).length,
    0
  )
  controller.dispose()
})

void test('closing or crashing the owner settles pending restores and releases the viewer', async () => {
  const { owner, child, controller } = fixture()
  const state = controller.getState(child.sender())
  const pending = controller.restore(child.sender(), {
    id: state.id,
    expectedContent: 'current',
    content: 'historic',
  })
  owner.webContents.emit('render-process-gone')
  assert.deepEqual(await pending, { ok: false, reason: 'unavailable' })
  assert.equal(child.destroyed, true)
  assert.deepEqual(owner.messages.at(-1), [channels.opened, null])
  controller.open(owner.sender(), file)
  const originalContents = owner.webContents
  Object.defineProperty(owner, 'webContents', {
    get: () => (owner.destroyed ? null : originalContents),
  })
  assert.doesNotThrow(() => owner.close())
  assert.throws(() => controller.getState(child.sender()), /Not a history window/)
  controller.dispose()
})
