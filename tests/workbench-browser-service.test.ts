import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'
import type { WebContents } from 'electron'

import type { ElectronBrowserRuntimeApi } from '@velaros-ai/capabilities/browser'

import {
  type WorkbenchBrowserRuntimeCallbacks,
  WorkbenchBrowserService,
} from '../src/main/browser/WorkbenchBrowserService'
import type { WorkbenchBrowserState } from '../src/shared/workbenchBrowser'

type Call = [method: string, ...args: unknown[]]

/** 假的浏览器运行时：记下每次调用；需要返回值的方法按名字给。 */
function createRig() {
  const calls: Call[] = []
  const opened: string[] = []
  const closed: string[] = []
  const states: WorkbenchBrowserState[] = []
  let callbacks!: WorkbenchBrowserRuntimeCallbacks
  const runtime = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        (...args: unknown[]) => {
          calls.push([name, ...args])
          if (name === 'getTurnContextSnapshot') return null
          if (name === 'dispose') return undefined
          return Promise.resolve({})
        },
    }
  ) as unknown as ElectronBrowserRuntimeApi
  const window = { id: 7 } as WebContents
  const otherWindow = { id: 8 } as WebContents
  const guests = new Map<number, WebContents>([
    [101, { id: 101, isDestroyed: () => false, hostWebContents: window } as unknown as WebContents],
    [202, { id: 202, isDestroyed: () => false, hostWebContents: otherWindow } as unknown as WebContents],
  ])
  const service = new WorkbenchBrowserService({
    createRuntime: (received) => {
      callbacks = received
      return runtime
    },
    siteWorkspaceRoot: '/data/browser-sites',
    backgroundPages: {
      open: (id) => {
        opened.push(id)
        return { id: 999 } as WebContents
      },
      close: (id) => closed.push(id),
      closeAll: () => undefined,
    },
    resolveGuest: (id) => guests.get(id) ?? null,
  })
  service.onChanged((state) => states.push(state))
  return { service, calls, opened, closed, states, window, callbacks: () => callbacks }
}

const ref = { projectRoot: '/work/app', sessionId: 'session-1' }
const signal = new AbortController().signal

describe('Workbench agent browser service', () => {
  test('entering a site records it, tells the window and waits for the page', async () => {
    const rig = createRig()
    const port = rig.service.conversation(ref).port(signal)
    await port.enterSite('example.com/docs')
    assert.deepEqual(rig.service.state(ref).site, { url: 'https://example.com/docs' })
    assert.deepEqual(rig.states.at(-1), { ...ref, site: { url: 'https://example.com/docs' } })
    const open = rig.calls.find(([method]) => method === 'openPage')
    assert.ok(open)
    // 站点工作区在项目之外，按站点分格
    const context = open[2] as { url: string; workspaceRoot: string }
    assert.equal(context.url, 'https://example.com/docs')
    assert.match(context.workspaceRoot.replaceAll('\\', '/'), /^\/data\/browser-sites\/example-com-[0-9a-f]{10}$/u)
  })

  test('only http and https addresses reach the page', async () => {
    const rig = createRig()
    const port = rig.service.conversation(ref).port(signal)
    await assert.rejects(port.enterSite('file:///etc/passwd'), /http 或 https/u)
    // 不像网址的输入是搜索词：脚本、浏览器内部页的写法变成一次搜索，页面不会跳去那些协议
    await port.enterSite('javascript:alert(1)')
    assert.match(rig.service.state(ref).site?.url ?? '', /^https:\/\/www\.google\.com\/search\?q=javascript/u)
    await assert.rejects(
      port.navigatePage({ action: 'goto', url: 'file:///etc/hosts' }),
      /http 或 https/u
    )
    await port.navigatePage({ action: 'back' })
    await assert.rejects(rig.service.navigate(ref, 'goto', 'file:///etc/hosts'), /http 或 https/u)
    const gotos = rig.calls
      .filter(([method]) => method === 'navigatePage')
      .map(([, , , options]) => options as { action: string; url?: string })
    assert.deepEqual(gotos, [{ action: 'back' }])
  })

  test('attaches only a webview that belongs to the calling window', async () => {
    const rig = createRig()
    await rig.service.conversation(ref).port(signal).enterSite('https://example.com/')
    await assert.rejects(rig.service.attachPage(ref, 202, rig.window), /不属于当前窗口/u)
    await assert.rejects(rig.service.attachPage(ref, 303, rig.window), /不属于当前窗口/u)
    await rig.service.attachPage(ref, 101, rig.window)
    const present = rig.calls.find(([method]) => method === 'presentPage')
    assert.ok(present)
    assert.equal(present[3], 101)
    // 界面的 webview 换下了后台页面
    assert.deepEqual(rig.closed, [present[1]])
  })

  test('the same chat session id in two projects drives two different pages', async () => {
    const rig = createRig()
    await rig.service.conversation(ref).port(signal).enterSite('https://a.test/')
    await rig.service.conversation({ ...ref, projectRoot: '/work/other' }).port(signal).enterSite('https://b.test/')
    const ids = rig.calls.filter(([method]) => method === 'openPage').map(([, id]) => id)
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
    assert.deepEqual(rig.service.state(ref).site, { url: 'https://a.test/' })
  })

  test('opens a background page only while a run holds the browser', async () => {
    const rig = createRig()
    const browser = rig.service.conversation(ref)
    await browser.port(signal).enterSite('https://example.com/')
    const runtimeId = rig.calls.find(([method]) => method === 'openPage')![1] as string
    const page = await rig.callbacks().provideBackgroundPage(runtimeId)
    assert.equal(page?.url, 'https://example.com/')
    assert.deepEqual(rig.opened, [runtimeId])
    rig.service.settleRun(ref)
    assert.equal(await rig.callbacks().provideBackgroundPage(runtimeId), null)
  })

  test('follows the page when it navigates by itself, and clears the tab when the session closes', async () => {
    const rig = createRig()
    await rig.service.conversation(ref).port(signal).enterSite('https://example.com/')
    const runtimeId = rig.calls.find(([method]) => method === 'openPage')![1] as string
    rig.callbacks().onSessionSiteChange(runtimeId, 'https://example.com/next')
    assert.deepEqual(rig.states.at(-1)?.site, { url: 'https://example.com/next' })
    rig.callbacks().onSessionClosed(runtimeId)
    assert.equal(rig.states.at(-1)?.site, null)
  })

  test('releasing a project leaves only that project’s sites', async () => {
    const rig = createRig()
    const other = { projectRoot: '/work/other', sessionId: 'session-1' }
    await rig.service.conversation(ref).port(signal).enterSite('https://a.test/')
    await rig.service.conversation(other).port(signal).enterSite('https://b.test/')
    await rig.service.releaseProject('/work/app/')
    assert.equal(rig.service.state(ref).site, null)
    assert.deepEqual(rig.service.state(other).site, { url: 'https://b.test/' })
  })

  test('refuses user scripts and describes the page every frame', async () => {
    const rig = createRig()
    const browser = rig.service.conversation(ref)
    assert.deepEqual(browser.environment(), { browser: '还没进站点' })
    await browser.port(signal).enterSite('https://example.com/')
    assert.deepEqual(browser.environment(), { browser: 'https://example.com/（页面还没显示出来）' })
    await assert.rejects(
      browser.port(signal).manageUserScripts({ action: 'list' } as never),
      /不支持用户脚本/u
    )
  })
})
