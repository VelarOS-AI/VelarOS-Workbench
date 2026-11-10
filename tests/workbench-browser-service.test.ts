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
type RuntimeOverrides = Partial<Pick<
  ElectronBrowserRuntimeApi,
  'closeSession' | 'openPage' | 'presentPage' | 'getTurnContextSnapshot'
>>

/** 假的浏览器运行时：记下每次调用；需要返回值的方法按名字给。 */
function createRig(overrides: RuntimeOverrides = {}) {
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
          if (name === 'closeSession' && overrides.closeSession)
            return overrides.closeSession(
              ...(args as Parameters<ElectronBrowserRuntimeApi['closeSession']>)
            )
          if (name === 'openPage' && overrides.openPage)
            return overrides.openPage(...(args as Parameters<ElectronBrowserRuntimeApi['openPage']>))
          if (name === 'presentPage' && overrides.presentPage)
            return overrides.presentPage(
              ...(args as Parameters<ElectronBrowserRuntimeApi['presentPage']>)
            )
          if (name === 'getTurnContextSnapshot' && overrides.getTurnContextSnapshot)
            return overrides.getTurnContextSnapshot(
              ...(args as Parameters<ElectronBrowserRuntimeApi['getTurnContextSnapshot']>)
            )
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

  test('page close retains its result while explicit replacement pages stay usable', async () => {
    const failure = new Error('protocol close failed')
    const slow = Promise.withResolvers<void>()
    const opening = Promise.withResolvers<void>()
    const presenting = Promise.withResolvers<void>()
    const oldClose = Promise.withResolvers<void>()
    let failedId = ''
    let failedAttempts = 0
    let holdPreparation = false
    let snapshotUrl: Nullable<string> = null
    const rig = createRig({
      closeSession: (id) => {
        // 095 在 closeSession 的首个 await 之前同步撤下当前页。
        rig.callbacks().onSessionClosed(id)
        if (id !== failedId) return slow.promise
        failedAttempts += 1
        if (failedAttempts === 1) return Promise.reject(failure)
        return failedAttempts === 2 ? oldClose.promise : Promise.resolve()
      },
      openPage: async (id, context) => {
        if (holdPreparation) await opening.promise
        if (context.url === 'https://newer.test/')
          assert.ok(await rig.callbacks().provideBackgroundPage(id))
      },
      presentPage: async () => {
        if (holdPreparation) await presenting.promise
        return {
          active: true, visible: true, driverKind: 'webview', url: 'https://new.test/',
          title: null, canGoBack: false, canGoForward: false, viewport: null,
        }
      },
      getTurnContextSnapshot: (id) => id === failedId && snapshotUrl ? {
        url: snapshotUrl, title: null, loadState: 'loaded', lastNavigationError: null,
        visible: true, viewport: null, pendingEvents: { dialog: 0, download: 0, permission: 0 },
        recentErrorCount: 0, capturedAt: 0,
      } : null,
    })
    const next = { ...ref, sessionId: 'session-2' }
    const port = rig.service.conversation(ref).port(signal)
    await port.enterSite('https://a.test/')
    await rig.service.conversation(next).port(signal).enterSite('https://b.test/')
    failedId = rig.calls.find(([method]) => method === 'openPage')![1] as string
    const closing = rig.service.leaveSite(ref)
    assert.equal(rig.service.leaveSite(ref), closing)
    const failed = assert.rejects(closing, (error: unknown) => error === failure)
    const release = rig.service.releaseProject(ref.projectRoot)
    const released = assert.rejects(release, (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [failure])
      return true
    })
    let settled = false
    void release.then(() => { settled = true }, () => { settled = true })
    await failed
    assert.equal(settled, false, 'the other session still owns its unfinished close')
    // 撤登记通知不是关闭成功；同 page 仍复用同一张失败票。
    assert.equal(rig.service.state(ref).site, null)
    await assert.rejects(rig.service.navigate(ref, 'reload'), { code: 'CLOSED' })
    slow.resolve()
    await released
    await assert.rejects(rig.service.releaseProject(ref.projectRoot), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [failure])
      return true
    })
    assert.equal(rig.service.leaveSite(ref), closing)
    assert.equal(failedAttempts, 1)
    assert.equal(rig.calls.filter(([method]) => method === 'closeSession').length, 2)

    // 显式新页不继承失败；它的 open 与 present 两项都须进入完整关闭票。
    holdPreparation = true
    const entered = port.enterSite('https://new.test/')
    const attached = rig.service.attachPage(ref, 101, rig.window)
    rig.callbacks().onSessionSiteChange(failedId, 'https://old.test/')
    assert.deepEqual(rig.service.state(ref).site, { url: 'https://new.test/' })
    const closingNew = rig.service.leaveSite(ref)
    const fullyClosed = assert.doesNotReject(closingNew)
    let newClosed = false
    void closingNew.then(() => { newClosed = true }, () => { newClosed = true })
    oldClose.resolve()
    await Promise.resolve()
    assert.equal(newClosed, false)
    opening.resolve()
    await entered
    assert.equal(newClosed, false, 'present is still preparing after open has settled')

    // 最后一个准备完成时换入真实新页：旧 present/close 续体不能再清它的站点或后台页面。
    presenting.resolve()
    holdPreparation = false
    snapshotUrl = 'https://newer.test/loaded'
    const backgroundCloses = rig.closed.length
    const newest = port.enterSite('https://newer.test/')
    await Promise.all([attached, fullyClosed, newest])
    assert.equal(rig.closed.length, backgroundCloses)
    assert.deepEqual(rig.service.state(ref).site, { url: snapshotUrl })
    await rig.service.navigate(ref, 'reload')
    await assert.rejects(closing, (error: unknown) => error === failure)

    const cancelled = new AbortController()
    const cancelledPort = rig.service.conversation(ref).port(cancelled.signal)
    cancelled.abort()
    const openCalls = rig.calls.filter(([method]) => method === 'openPage').length
    await assert.rejects(cancelledPort.enterSite('https://cancelled.test/'))
    assert.equal(rig.calls.filter(([method]) => method === 'openPage').length, openCalls)
    assert.deepEqual(rig.service.state(ref).site, { url: snapshotUrl })
    await rig.service.leaveSite(ref)
    assert.equal(rig.calls.filter(([method]) => method === 'closeSession').length, 4)
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
