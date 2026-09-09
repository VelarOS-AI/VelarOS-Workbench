import { describe, expect, test } from 'bun:test'

import {
  type WorkbenchBrowserGuest,
  WorkbenchBrowserWebviewGate,
} from '../src/main/browser/WorkbenchBrowserWebviewGate'

describe('Workbench Browser webview Mod gate', () => {
  test('rejects guests while disabled and closes tracked guests on disable', () => {
    const modState = createModState(true)
    const gate = new WorkbenchBrowserWebviewGate(modState)
    const first = createGuest()

    expect(gate.allowsAttachment()).toBe(true)
    expect(gate.ownsGuest(first.guest)).toBe(false)
    expect(gate.track(first.guest)).toBe(true)
    expect(gate.ownsGuest(first.guest)).toBe(true)
    expect(first.closeCount()).toBe(0)

    modState.setEnabled(false)
    expect(gate.allowsAttachment()).toBe(false)
    expect(gate.ownsGuest(first.guest)).toBe(false)
    expect(first.closeCount()).toBe(1)

    const rejected = createGuest()
    expect(gate.track(rejected.guest)).toBe(false)
    expect(gate.ownsGuest(rejected.guest)).toBe(false)
    expect(rejected.closeCount()).toBe(1)

    modState.setEnabled(true)
    expect(gate.allowsAttachment()).toBe(true)
    expect(gate.ownsGuest(first.guest)).toBe(false)
  })

  test('does not close a guest twice after Electron reports it destroyed', () => {
    const modState = createModState(true)
    const gate = new WorkbenchBrowserWebviewGate(modState)
    const fixture = createGuest()
    gate.track(fixture.guest)

    fixture.destroy()
    expect(gate.ownsGuest(fixture.guest)).toBe(false)
    modState.setEnabled(false)
    gate.dispose()

    expect(fixture.closeCount()).toBe(0)
  })

  test('rejects a destroyed guest before its destroyed event is delivered', () => {
    const gate = new WorkbenchBrowserWebviewGate(createModState(true))
    const fixture = createGuest()
    expect(gate.track(fixture.guest)).toBe(true)

    fixture.guest.isDestroyed = () => true
    expect(gate.ownsGuest(fixture.guest)).toBe(false)
    gate.dispose()
    expect(fixture.closeCount()).toBe(0)
  })

  test('revokes ownership and rejects new guests after disposal', () => {
    const modState = createModState(true)
    const gate = new WorkbenchBrowserWebviewGate(modState)
    const fixture = createGuest()
    gate.track(fixture.guest)

    gate.dispose()
    gate.dispose()
    expect(gate.allowsAttachment()).toBe(false)
    expect(gate.ownsGuest(fixture.guest)).toBe(false)
    expect(fixture.closeCount()).toBe(1)

    const rejected = createGuest()
    expect(gate.track(rejected.guest)).toBe(false)
    expect(gate.ownsGuest(rejected.guest)).toBe(false)
    expect(rejected.closeCount()).toBe(1)
    modState.setEnabled(false)
    modState.setEnabled(true)
    expect(gate.allowsAttachment()).toBe(false)
  })
})

function createModState(initialEnabled: boolean): {
  isEnabled: (id: 'velaros.browser') => boolean
  subscribe: (listener: () => void) => () => void
  setEnabled: (enabled: boolean) => void
} {
  let enabled = initialEnabled
  const listeners = new Set<() => void>()
  return {
    isEnabled: () => enabled,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setEnabled: (next) => {
      enabled = next
      for (const listener of listeners) listener()
    },
  }
}

function createGuest(): {
  guest: WorkbenchBrowserGuest
  closeCount: () => number
  destroy: () => void
} {
  let destroyed = false
  let closes = 0
  const destroyedListeners: Array<() => void> = []
  return {
    guest: {
      isDestroyed: () => destroyed,
      close: () => {
        closes += 1
        destroyed = true
        for (const listener of destroyedListeners.splice(0)) listener()
      },
      once: (_event, listener) => {
        destroyedListeners.push(listener)
      },
    },
    closeCount: () => closes,
    destroy: () => {
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) listener()
    },
  }
}
