import { describe, expect, test } from 'bun:test'

import {
  type WorkbenchBrowserGuest,
  WorkbenchBrowserWebviewGate,
} from '../src/main/browser/WorkbenchBrowserWebviewGate'

describe('Workbench Browser webview gate', () => {
  test('owns only the guests it tracked, without closing them while it is open', () => {
    const gate = new WorkbenchBrowserWebviewGate()
    const first = createGuest()
    const untracked = createGuest()

    expect(gate.allowsAttachment()).toBe(true)
    expect(gate.ownsGuest(first.guest)).toBe(false)
    expect(gate.track(first.guest)).toBe(true)
    // 同一个 guest 重复登记照样放行，不重复挂 destroyed 监听。
    expect(gate.track(first.guest)).toBe(true)
    expect(first.destroyedListenerCount()).toBe(1)
    expect(gate.ownsGuest(first.guest)).toBe(true)
    expect(gate.ownsGuest(untracked.guest)).toBe(false)
    expect(first.closeCount()).toBe(0)
    expect(untracked.closeCount()).toBe(0)
  })

  test('does not close a guest twice after Electron reports it destroyed', () => {
    const gate = new WorkbenchBrowserWebviewGate()
    const fixture = createGuest()
    gate.track(fixture.guest)

    fixture.destroy()
    expect(gate.ownsGuest(fixture.guest)).toBe(false)
    gate.dispose()

    expect(fixture.closeCount()).toBe(0)
  })

  test('rejects a destroyed guest before its destroyed event is delivered', () => {
    const gate = new WorkbenchBrowserWebviewGate()
    const fixture = createGuest()
    expect(gate.track(fixture.guest)).toBe(true)

    fixture.guest.isDestroyed = () => true
    expect(gate.ownsGuest(fixture.guest)).toBe(false)
    gate.dispose()
    expect(fixture.closeCount()).toBe(0)

    // 登记时就已销毁的 guest 不收，也不再去关它。
    const late = createGuest()
    late.guest.isDestroyed = () => true
    expect(new WorkbenchBrowserWebviewGate().track(late.guest)).toBe(false)
    expect(late.closeCount()).toBe(0)
  })

  test('closes tracked guests, revokes ownership and rejects new guests after disposal', () => {
    const gate = new WorkbenchBrowserWebviewGate()
    const first = createGuest()
    const second = createGuest()
    gate.track(first.guest)
    gate.track(second.guest)

    gate.dispose()
    gate.dispose()
    expect(gate.allowsAttachment()).toBe(false)
    expect(gate.ownsGuest(first.guest)).toBe(false)
    expect(gate.ownsGuest(second.guest)).toBe(false)
    expect(first.closeCount()).toBe(1)
    expect(second.closeCount()).toBe(1)

    const rejected = createGuest()
    expect(gate.track(rejected.guest)).toBe(false)
    expect(gate.ownsGuest(rejected.guest)).toBe(false)
    expect(rejected.closeCount()).toBe(1)
  })
})

function createGuest(): {
  guest: WorkbenchBrowserGuest
  closeCount: () => number
  destroyedListenerCount: () => number
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
    destroyedListenerCount: () => destroyedListeners.length,
    destroy: () => {
      destroyed = true
      for (const listener of destroyedListeners.splice(0)) listener()
    },
  }
}
