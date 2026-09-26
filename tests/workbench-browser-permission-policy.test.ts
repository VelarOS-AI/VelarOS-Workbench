import { describe, expect, test } from 'bun:test'
import type { Session, WebContents } from 'electron'

import {
  installWorkbenchBrowserDefaultPermissionPolicy,
  type WorkbenchBrowserPermissionSession,
} from '../src/main/browser/WorkbenchBrowserPermissionPolicy'

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>

function createRig(registerGuest = true) {
  let requestHandler: RequestHandler
  let checkHandler: CheckHandler
  let deviceHandler: Parameters<Session['setDevicePermissionHandler']>[0]
  const state = { owned: true, destroyed: false, url: 'http://127.0.0.1:7173/world' }
  const guest = {
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
  } as WebContents
  const session: WorkbenchBrowserPermissionSession = {
    setPermissionRequestHandler: (handler) => { requestHandler = handler! },
    setPermissionCheckHandler: (handler) => { checkHandler = handler! },
    setDevicePermissionHandler: (handler) => { deviceHandler = handler },
  }
  const dispose = installWorkbenchBrowserDefaultPermissionPolicy(session, registerGuest ? {
    isInteractiveGuest: (candidate) => candidate === guest && state.owned,
  } : undefined)
  return {
    state, guest, session, dispose,
    check: (permission: Parameters<CheckHandler>[1], origin = 'http://127.0.0.1:7173',
      requestingUrl = state.url, candidate: WebContents | null = guest) =>
      checkHandler(candidate, permission, origin, { isMainFrame: true, requestingUrl }),
    request: (permission: Parameters<RequestHandler>[1], requestingUrl = state.url,
      candidate = guest) => {
      const results: boolean[] = []
      requestHandler(candidate, permission, (granted) => results.push(granted), {
        isMainFrame: true, requestingUrl,
      })
      return results
    },
    device: () => deviceHandler?.({} as never),
  }
}

describe('Workbench browser interactive permissions', () => {
  test('allows pointer lock for a registered web guest', () => {
    const rig = createRig()
    expect(rig.check('pointerLock')).toBe(true)
    expect(rig.request('pointerLock')).toEqual([true])
    rig.state.url = 'https://game.example/world'
    expect(rig.check('pointerLock', 'https://game.example')).toBe(true)
    expect(rig.request('pointerLock')).toEqual([true])
  })

  test('does not authorize unrelated contents merely because their URL matches', () => {
    const rig = createRig()
    const foreign = { isDestroyed: () => false, getURL: () => rig.state.url } as WebContents
    expect(rig.request('pointerLock', rig.state.url, foreign)).toEqual([false])
    expect(rig.check('pointerLock', 'http://127.0.0.1:7173', rig.state.url, foreign)).toBe(false)
    expect(rig.check('pointerLock', 'http://127.0.0.1:7173', rig.state.url, null)).toBe(false)
    const unregistered = createRig(false)
    expect(unregistered.request('pointerLock')).toEqual([false])
    expect(unregistered.check('pointerLock')).toBe(false)
  })

  test('rejects foreign origins, malformed URLs and privileged pages', () => {
    const rig = createRig()
    for (const url of ['http://127.0.0.1:7174/', 'https://other.example/', '', 'not a URL',
      'about:blank', 'file:///tmp/game.html', 'https://user:password@game.example/']) {
      expect(rig.request('pointerLock', url)).toEqual([false])
      expect(rig.check('pointerLock', url)).toBe(false)
      expect(rig.check('pointerLock', 'http://127.0.0.1:7173', url)).toBe(false)
    }
    rig.state.url = 'file:///tmp/game.html'
    expect(rig.request('pointerLock')).toEqual([false])
  })

  test('rechecks guest lifetime and gate ownership on every request', () => {
    const rig = createRig()
    rig.state.destroyed = true
    expect(rig.check('pointerLock')).toBe(false)
    expect(rig.request('pointerLock')).toEqual([false])
    rig.state.destroyed = false
    rig.state.owned = false
    expect(rig.check('pointerLock')).toBe(false)
    expect(rig.request('pointerLock')).toEqual([false])
    rig.state.owned = true
    expect(rig.request('pointerLock')).toEqual([true])
  })

  test('denies every other permission and device request, and keeps the gateway after dispose', () => {
    const rig = createRig()
    for (const permission of ['geolocation', 'media', 'clipboard-read', 'keyboardLock'] as const) {
      expect(rig.request(permission)).toEqual([false])
    }
    for (const permission of ['geolocation', 'media', 'clipboard-read', 'usb'] as const) {
      expect(rig.check(permission)).toBe(false)
    }
    expect(rig.device()).toBe(false)
    expect(rig.request('pointerLock')).toEqual([true])
    // Session 与应用同寿命：清理函数不撤掉 fail-closed gateway，指针锁定仍按宿主登记放行。
    rig.dispose()
    expect(rig.request('pointerLock')).toEqual([true])
    expect(rig.request('geolocation')).toEqual([false])
    expect(rig.check('geolocation')).toBe(false)
  })
})
