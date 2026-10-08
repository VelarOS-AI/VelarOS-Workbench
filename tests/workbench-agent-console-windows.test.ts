import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'bun:test'
import type { BrowserWindow } from 'electron'

import { WorkbenchAgentConsoleWindows } from '../src/main/projects/WorkbenchAgentConsoleWindows'

class ConsoleWindow extends EventEmitter {
  public destroyed = false
  public minimized = true
  public visible = false
  public focused = false
  public isDestroyed(): boolean { return this.destroyed }
  public isMinimized(): boolean { return this.minimized }
  public isVisible(): boolean { return this.visible }
  public restore(): void { this.minimized = false }
  public show(): void { this.visible = true }
  public focus(): void { this.focused = true }
  public close(): void { this.destroyed = true; this.emit('closed') }
  public asWindow(): BrowserWindow { return this as unknown as BrowserWindow }
}

test('reactivating a console restores only its owning project window', () => {
  const windows = new WorkbenchAgentConsoleWindows()
  const first = new ConsoleWindow()
  const second = new ConsoleWindow()
  windows.register(1, first.asWindow())
  windows.register(2, second.asWindow())
  assert.equal(windows.focus(1), true)
  assert.equal(first.minimized, false)
  assert.equal(first.visible, true)
  assert.equal(first.focused, true)
  assert.equal(second.focused, false)
  assert.equal(windows.focus(3), false)
  windows.releaseOwner(1)
  assert.equal(first.destroyed, true)
  assert.equal(windows.focus(1), false)
  assert.equal(second.destroyed, false)
})

test('a closed console is released and an older close cannot remove its replacement', () => {
  const windows = new WorkbenchAgentConsoleWindows()
  const old = new ConsoleWindow()
  const current = new ConsoleWindow()
  windows.register(1, old.asWindow())
  windows.register(1, current.asWindow())
  old.close()
  assert.equal(windows.focus(1), true)
  assert.equal(current.focused, true)
  current.close()
  assert.equal(windows.focus(1), false)
})
