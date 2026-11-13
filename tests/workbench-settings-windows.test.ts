import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mock, test } from 'bun:test'
import type { BrowserWindow, WebContents } from 'electron'

import { WorkbenchSettingsWindows } from '../src/main/projects/WorkbenchSettingsWindows'

mock.module('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

class SettingsTestWindow extends EventEmitter {
  private static sequence = 9000
  public destroyed = false
  public minimized = false
  public visible = false
  public focused = false
  public readonly messages: unknown[] = []
  public readonly webContents = {
    id: SettingsTestWindow.sequence++,
    isDestroyed: () => this.destroyed,
    send: (...args: unknown[]) => this.messages.push(args),
  }
  public isDestroyed(): boolean {
    return this.destroyed
  }
  public isMinimized(): boolean {
    return this.minimized
  }
  public isVisible(): boolean {
    return this.visible
  }
  public restore(): void {
    this.minimized = false
  }
  public show(): void {
    this.visible = true
  }
  public focus(): void {
    this.focused = true
  }
  public close(): void {
    this.destroyed = true
    this.emit('closed')
  }
  public asWindow(): BrowserWindow {
    return this as unknown as BrowserWindow
  }
  public sender(): WebContents {
    return this.webContents as unknown as WebContents
  }
}

test('settings reuse one native window, restore it and route project exit to the editor owner', () => {
  const owner = new SettingsTestWindow()
  const created: SettingsTestWindow[] = []
  const menu: unknown[] = []
  const controller = new WorkbenchSettingsWindows({
    windows: {
      getWindowForWebContents: (sender) =>
        sender.id === owner.webContents.id ||
        created.some((window) => window.webContents.id === sender.id)
          ? owner.asWindow()
          : null,
      registerAuxiliaryWindow: () => {},
      sendMenuCommandToWindow: (...args) => {
        menu.push(args)
      },
    },
    createWindow: () => {
      const window = new SettingsTestWindow()
      created.push(window)
      return window.asWindow()
    },
    loadWindow: (window) => {
      ;(window as unknown as SettingsTestWindow).emit('ready-to-show')
    },
  })
  controller.open(owner.sender())
  assert.equal(created.length, 1)
  const first = created[0]!
  assert.equal(first.visible, true)
  first.minimized = true
  first.focused = false
  controller.open(owner.sender())
  assert.equal(created.length, 1)
  assert.equal(first.minimized, false)
  assert.equal(first.focused, true)
  controller.exitProject(first.sender())
  assert.deepEqual(menu, [[owner.asWindow(), 'close-project']])
  controller.close(owner.sender())
  assert.equal(owner.destroyed, false)
  assert.equal(first.destroyed, false)
  controller.close(first.sender())
  assert.equal(first.destroyed, true)
  controller.open(owner.sender())
  assert.equal(created.length, 2)
  assert.throws(() => controller.open(new SettingsTestWindow().sender()), /Settings require/u)
  controller.dispose()
  assert.equal(created[1]!.destroyed, true)
})

test('settings inherit only their owner project, receive project changes and close with the owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-settings-owner-'))
  try {
    const project = join(root, 'project')
    const foreign = join(root, 'foreign')
    await Promise.all([mkdir(project), mkdir(foreign)])
    const { WorkbenchWindowManager } = await import('../src/main/projects/WorkbenchWindowManager')
    const manager = new WorkbenchWindowManager(root, {
      createBrowserWindow: () => new SettingsTestWindow().asWindow(),
    })
    const owner = manager.createWindow(project) as unknown as SettingsTestWindow
    const child = new SettingsTestWindow()
    manager.registerAuxiliaryWindow(owner.sender(), child.asWindow())
    assert.equal(
      manager.getHubForWebContents(child.sender())?.getState().currentProject?.path,
      project
    )
    assert.deepEqual(manager.getOpenProjectPaths(), [project])
    manager.assertProjectForWebContents(child.sender(), project)
    assert.throws(() => manager.assertProjectForWebContents(child.sender(), foreign), /not owned/u)
    assert.equal(manager.getHubForWebContents(new SettingsTestWindow().sender()), null)
    await manager.returnToEntry(owner.sender())
    assert.equal(manager.getHubForWebContents(child.sender())?.getState().currentProject, null)
    assert.ok(child.messages.length > 0)
    owner.close()
    assert.equal(child.destroyed, true)
    assert.equal(manager.getHubForWebContents(child.sender()), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
