import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import type { WebContents } from 'electron'

import type {
  BrowserSpacePort,
  ElectronBrowserRuntimeApi,
  ElectronBrowserRuntimeOptions,
} from '@velaros-ai/capabilities/browser'
import type {
  BrowserPageNavigationOptions,
  BrowserSiteContext,
} from '@velaros-ai/capabilities/browser/contracts'
import { browserAddress } from '@velaros-ai/capabilities/browser/renderer'
import { isEmpty, Log, toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  normalizeWorkbenchBrowserPageUrl,
  type WorkbenchBrowserNavigationAction,
  type WorkbenchBrowserState,
} from '../../shared/workbenchBrowser'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchBrowserBackgroundPagesApi } from './WorkbenchBrowserBackgroundPages'

/** 服务接给运行时的回调；运行时由装配层建，建的时候接进去。 */
export type WorkbenchBrowserRuntimeCallbacks = Required<
  Pick<
    ElectronBrowserRuntimeOptions,
    'onSessionSiteChange' | 'onSessionClosed' | 'provideBackgroundPage'
  >
>

/** 一个聊天会话的浏览器：会话在哪个项目里、是哪个会话。 */
export interface WorkbenchBrowserRef {
  projectRoot: string
  sessionId: string
}

/** 一轮运行交给模型的浏览器：空间端口，加每帧放进环境报告的「浏览器现在在哪一页」。 */
export interface ConversationBrowser {
  port(signal: AbortSignal): BrowserSpacePort
  environment(): Readonly<Record<string, string>>
}

interface WorkbenchBrowserServiceOptions {
  /** 建进程唯一的浏览器运行时，并接上服务的回调。 */
  createRuntime(callbacks: WorkbenchBrowserRuntimeCallbacks): ElectronBrowserRuntimeApi
  /** 站点工作区的根目录（截图、下载、PDF 落在这里）：在任何项目之外，同一个站点跨会话共用一格。 */
  siteWorkspaceRoot: string
  backgroundPages: WorkbenchBrowserBackgroundPagesApi
  /** 按 id 找页面（Electron 的 `webContents.fromId`）：接管前核对它是不是这个窗口自己的 webview。 */
  resolveGuest(webContentsId: number): Nullable<WebContents>
}

type StateListener = (state: WorkbenchBrowserState) => void

/**
 * Agent 浏览器（与 Desktop 的浏览器服务同一套，只有内置浏览器这一种）：每个聊天会话一个受控页面，界面在编辑区的
 * 浏览器标签里把 webview 交给运行时接管；模型经 velaros:browser / devtools / cdp 操作同一个页面。
 *
 * 运行时一个进程一份，按运行时会话管页面：运行时会话 id 由项目根与聊天会话 id 算出，不同窗口、不同项目不会撞。
 * 站点只在内存里；进站、页面自己跳走、离站都通知这个会话所在项目的窗口。只认 http 与 https 的地址。
 */
export class WorkbenchBrowserService {
  private readonly log = Log.tag('WorkbenchBrowserService')
  private readonly runtime: ElectronBrowserRuntimeApi
  private readonly refs = new Map<string, WorkbenchBrowserRef>()
  private readonly sites = new Map<string, BrowserSiteContext>()
  private readonly listeners = new Set<StateListener>()
  /** 这一轮运行正拿着浏览器的会话：只给它们开后台页面。 */
  private readonly running = new Set<string>()

  public constructor(private readonly options: WorkbenchBrowserServiceOptions) {
    this.runtime = options.createRuntime({
      // 页面自己导航（点链接、重定向、前进后退）：站点上下文跟着页面走。
      onSessionSiteChange: (runtimeId, url) => {
        this.recordSite(runtimeId, url)
      },
      onSessionClosed: (runtimeId) => {
        options.backgroundPages.close(runtimeId)
        this.clearSite(runtimeId)
      },
      // 编辑区没挂着这个会话的网页、这一轮运行又要用：开一个不显示的页面，运行时接管后加载站点。
      provideBackgroundPage: (runtimeId) => {
        const site = this.sites.get(runtimeId)
        if (!site || !this.running.has(runtimeId)) return Promise.resolve(null)
        return Promise.resolve({
          webContents: options.backgroundPages.open(runtimeId),
          url: site.url,
        })
      },
    })
  }

  public state(ref: WorkbenchBrowserRef): WorkbenchBrowserState {
    const site = this.sites.get(this.runtimeId(ref))
    return { ...ref, site: site ? { url: site.url } : null }
  }

  /** 编辑区把这个窗口里的 webview 交给运行时接管；接管后后台页面就关掉。 */
  public async attachPage(
    ref: WorkbenchBrowserRef,
    webContentsId: number,
    owner: WebContents
  ): Promise<void> {
    const guest = this.options.resolveGuest(webContentsId)
    // 只接这个窗口自己的 webview：别的窗口、别的页面的 WebContents 不能被拿来当 Agent 的页面。
    if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== owner.id)
      throw new AppError('PERMISSION', workbenchMainText('browser.pageNotInWindow'))
    const runtimeId = this.runtimeId(ref)
    await this.runtime.presentPage(runtimeId, this.requireSite(runtimeId), webContentsId)
    this.options.backgroundPages.close(runtimeId)
  }

  /** 编辑区收起页面（切走标签）：隐藏但不关，站点保留；运行要用时开后台页面。 */
  public async detachPage(ref: WorkbenchBrowserRef): Promise<void> {
    const runtimeId = this.runtimeId(ref)
    if (!this.sites.has(runtimeId)) return
    await this.runtime.hideSession(runtimeId)
  }

  /** 地址栏与前进、后退、刷新：经运行时导航，界面不自己 loadURL。 */
  public async navigate(
    ref: WorkbenchBrowserRef,
    action: WorkbenchBrowserNavigationAction,
    url?: string
  ): Promise<void> {
    const runtimeId = this.runtimeId(ref)
    await this.runtime.navigatePage(
      runtimeId,
      this.requireSite(runtimeId),
      navigationOptions(action, url)
    )
  }

  /** 离开站点（标签关掉、会话删除时）：关掉页面会话和后台页面，清掉站点。 */
  public async leaveSite(ref: WorkbenchBrowserRef): Promise<void> {
    const runtimeId = this.runtimeId(ref)
    await this.runtime.closeSession(runtimeId)
    this.options.backgroundPages.close(runtimeId)
    this.clearSite(runtimeId)
  }

  /** 窗口关掉或切走项目：这个项目里所有会话的浏览器一并离站。 */
  public async releaseProject(projectRoot: string): Promise<void> {
    const target = resolve(projectRoot)
    const owned = [...this.refs.entries()].filter(([, ref]) => resolve(ref.projectRoot) === target)
    await Promise.allSettled(owned.map(([, ref]) => this.leaveSite(ref)))
    for (const [runtimeId] of owned) this.refs.delete(runtimeId)
  }

  /**
   * 这个会话这一轮交给模型的浏览器。这一轮拿着浏览器期间，编辑区没挂着网页时运行时会要后台页面；
   * 这一轮结束要调 settleRun。
   */
  public conversation(ref: WorkbenchBrowserRef): ConversationBrowser {
    const runtimeId = this.runtimeId(ref)
    this.running.add(runtimeId)
    return {
      port: (signal) => this.port(runtimeId, signal),
      environment: () => ({
        browser: describeBrowserPage(
          this.sites.get(runtimeId)?.url ?? null,
          this.runtime.getTurnContextSnapshot(runtimeId)
        ),
      }),
    }
  }

  /** 会话的一轮运行结束：不再给它开后台页面，开着的关掉。 */
  public settleRun(ref: WorkbenchBrowserRef): void {
    const runtimeId = this.runtimeId(ref)
    this.running.delete(runtimeId)
    this.options.backgroundPages.close(runtimeId)
  }

  public onChanged(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 应用退出：释放运行时，关掉全部后台页面。 */
  public close(): void {
    this.listeners.clear()
    this.sites.clear()
    this.running.clear()
    this.runtime.dispose()
    this.options.backgroundPages.closeAll()
  }

  /** 模型用的空间端口：站点在每次调用时现读，模型进出站点后下一次调用就落在新站点上。取消信号是这一次调用的。 */
  private port(runtimeId: string, signal: AbortSignal): BrowserSpacePort {
    const runtime = this.runtime
    // 没进站点时以拒绝交出去：端口的方法约定返回 Promise。
    const withSite = <T>(run: (site: BrowserSiteContext) => Promise<T>): Promise<T> =>
      Promise.resolve().then(() => run(this.requireSite(runtimeId)))
    return {
      isActive: () => this.sites.has(runtimeId),
      getContext: () => toNullable(this.sites.get(runtimeId)),
      enterSite: async (url) => {
        const context = this.recordSite(runtimeId, requireWebAddress(url))
        // 界面收到通知才把页面挂出来（或由后台页面顶上）：这里等它挂上并加载到这个地址。
        await runtime.openPage(runtimeId, context, signal)
        return this.sites.get(runtimeId) ?? context
      },
      leaveSite: () => {
        const ref = this.refs.get(runtimeId)
        return ref ? this.leaveSite(ref) : Promise.resolve()
      },
      showPage: () => withSite((site) => runtime.showPage(runtimeId, site, signal)),
      inspectPage: (options) =>
        withSite((site) => runtime.inspectPage(runtimeId, site, options, signal)),
      captureScreenshot: (options) =>
        withSite((site) => runtime.captureScreenshot(runtimeId, site, options, signal)),
      performTargetAction: (options) =>
        withSite((site) => runtime.performTargetAction(runtimeId, site, options, signal)),
      navigatePage: (options) =>
        withSite((site) =>
          runtime.navigatePage(
            runtimeId,
            site,
            navigationOptions(options.action, options.url),
            signal
          )
        ),
      getPageDiagnostics: (options) =>
        withSite((site) => runtime.getPageDiagnostics(runtimeId, site, options, signal)),
      insertText: (options) =>
        withSite((site) => runtime.insertText(runtimeId, site, options, signal)),
      pressKey: (options) => withSite((site) => runtime.pressKey(runtimeId, site, options, signal)),
      keyDown: (input) => withSite((site) => runtime.keyDown(runtimeId, site, input, signal)),
      keyUp: (input) => withSite((site) => runtime.keyUp(runtimeId, site, input, signal)),
      moveMouse: (options) =>
        withSite((site) => runtime.moveMouse(runtimeId, site, options, signal)),
      mouseDown: (input) => withSite((site) => runtime.mouseDown(runtimeId, site, input, signal)),
      mouseUp: (input) => withSite((site) => runtime.mouseUp(runtimeId, site, input, signal)),
      mouseWheel: (input) => withSite((site) => runtime.mouseWheel(runtimeId, site, input, signal)),
      clickCoordinates: (options) =>
        withSite((site) => runtime.clickCoordinates(runtimeId, site, options, signal)),
      dragTargets: (options) =>
        withSite((site) => runtime.dragTargets(runtimeId, site, options, signal)),
      waitForPage: (options) =>
        withSite((site) => runtime.waitForPage(runtimeId, site, options, signal)),
      setPageZoom: (options) =>
        withSite((site) => runtime.setPageZoom(runtimeId, site, options, signal)),
      configureNetwork: (options) =>
        withSite((site) => runtime.configureNetwork(runtimeId, site, options, signal)),
      readNetworkRequestDetails: (options) =>
        withSite((site) => runtime.readNetworkRequestDetails(runtimeId, site, options, signal)),
      startPerformanceTrace: (options) =>
        withSite((site) => runtime.startPerformanceTrace(runtimeId, site, options, signal)),
      stopPerformanceTrace: () =>
        withSite((site) => runtime.stopPerformanceTrace(runtimeId, site, signal)),
      analyzePerformanceInsight: (options) =>
        withSite((site) => runtime.analyzePerformanceInsight(runtimeId, site, options, signal)),
      captureHeapSnapshot: (options) =>
        withSite((site) => runtime.captureHeapSnapshot(runtimeId, site, options, signal)),
      startScreencast: (options) =>
        withSite((site) => runtime.startScreencast(runtimeId, site, options, signal)),
      stopScreencast: (options) =>
        withSite((site) => runtime.stopScreencast(runtimeId, site, options, signal)),
      listPendingEvents: () =>
        withSite((site) => runtime.listPendingEvents(runtimeId, site, signal)),
      listPageTargets: () => withSite((site) => runtime.listPageTargets(runtimeId, site, signal)),
      switchPageTarget: (options) =>
        withSite((site) => runtime.switchPageTarget(runtimeId, site, options, signal)),
      handleDialog: (options) =>
        withSite((site) => runtime.handleDialog(runtimeId, site, options, signal)),
      handleDownload: (options) =>
        withSite((site) => runtime.handleDownload(runtimeId, site, options, signal)),
      handlePermission: (options) =>
        withSite((site) => runtime.handlePermission(runtimeId, site, options, signal)),
      uploadFile: (options) =>
        withSite((site) => runtime.uploadFile(runtimeId, site, options, signal)),
      fetchResource: (options) =>
        withSite((site) => runtime.fetchResource(runtimeId, site, options, signal)),
      exportPagePdf: (options) =>
        withSite((site) => runtime.exportPagePdf(runtimeId, site, options, signal)),
      listFrames: () => withSite((site) => runtime.listFrames(runtimeId, site, signal)),
      evaluateScript: (options) =>
        withSite((site) => runtime.evaluateScript(runtimeId, site, options, signal)),
      sendProtocolCommand: (command) =>
        withSite((site) => runtime.sendProtocolCommand(runtimeId, site, command, signal)),
      readProtocolEvents: (query) =>
        withSite((site) => runtime.readProtocolEvents(runtimeId, site, query, signal)),
      resetProtocolSession: () =>
        withSite((site) => runtime.resetProtocolSession(runtimeId, site, signal)),
      getPageState: () => withSite((site) => runtime.getPageState(runtimeId, site, signal)),
      // 用户脚本会在用户以后打开的页面里长期跑：Workbench 没有管理它们的界面，也就不让模型建。
      manageUserScripts: () =>
        Promise.reject(
          new AppError('UNAVAILABLE', workbenchMainText('browser.userScriptsUnsupported'))
        ),
    }
  }

  /** 运行时会话 id：项目根与聊天会话 id 一起算，别的窗口、别的项目里同名的会话不会撞上。 */
  private runtimeId(ref: WorkbenchBrowserRef): string {
    const id = `wb-${createHash('sha256')
      .update(`${resolve(ref.projectRoot)}\0${ref.sessionId}`)
      .digest('hex')
      .slice(0, 32)}`
    if (!this.refs.has(id))
      this.refs.set(id, { projectRoot: ref.projectRoot, sessionId: ref.sessionId })
    return id
  }

  /** 记下会话的站点：地址跟着页面，工作区根按站点分格（同站点内导航不换根）。 */
  private recordSite(runtimeId: string, url: string): BrowserSiteContext {
    const site = {
      url,
      workspaceRoot: join(this.options.siteWorkspaceRoot, siteDirectoryName(url)),
    }
    this.sites.set(runtimeId, site)
    this.notify(runtimeId)
    return site
  }

  private clearSite(runtimeId: string): void {
    if (this.sites.delete(runtimeId)) this.notify(runtimeId)
  }

  private requireSite(runtimeId: string): BrowserSiteContext {
    const site = this.sites.get(runtimeId)
    if (!site) throw new AppError('VALIDATION', workbenchMainText('browser.noPageOpen'))
    return site
  }

  /** 逐个通知；一个监听者出错不影响别的，也不影响浏览器本身。 */
  private notify(runtimeId: string): void {
    const ref = this.refs.get(runtimeId)
    if (!ref) return
    const state = this.state(ref)
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        this.log.warn('浏览器变化通知失败', { error: AppError.getMessage(error) })
      }
    }
  }
}

/** 地址栏或模型给的地址：不像网址的按搜索词展开，最后只认 http 与 https。 */
function requireWebAddress(input: string): string {
  const address = normalizeWorkbenchBrowserPageUrl(
    browserAddress.resolveSearchOrNavigationInput(input) ?? '',
    { allowAboutBlank: false }
  )
  if (!address)
    throw new AppError(
      'VALIDATION',
      workbenchMainText('browser.unsupportedAddress', { address: input })
    )
  return address
}

function navigationOptions(
  action: WorkbenchBrowserNavigationAction,
  url?: string
): BrowserPageNavigationOptions {
  return action === 'goto' ? { action, url: requireWebAddress(url ?? '') } : { action }
}

/** 站点工作区的目录名：按 host（带端口）分格，可读名加摘要。 */
function siteDirectoryName(url: string): string {
  const host = new URL(url).host.toLowerCase()
  const readable =
    host
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48) || 'site'
  return `${readable}-${createHash('sha1').update(host).digest('hex').slice(0, 10)}`
}

/** 每帧交给模型的「浏览器现在在哪一页」（与 Desktop 同一措辞）。 */
function describeBrowserPage(
  siteUrl: Nullable<string>,
  snapshot: ReturnType<ElectronBrowserRuntimeApi['getTurnContextSnapshot']>
): string {
  if (!siteUrl) return '还没进站点'
  if (!snapshot) return `${siteUrl}（页面还没显示出来）`

  const url = snapshot.url || siteUrl
  const parts = [snapshot.title ? `${url}「${snapshot.title}」` : url]
  const failure = snapshot.lastNavigationError
  if (failure) parts.push(`加载失败：${failure.errorDescription}（${failure.errorCode}）`)
  const { dialog, download, permission } = snapshot.pendingEvents
  const pending = [
    dialog ? `弹窗 ${dialog}` : '',
    download ? `下载 ${download}` : '',
    permission ? `权限请求 ${permission}` : '',
  ].filter(Boolean)
  if (!isEmpty(pending)) parts.push(`待处理：${pending.join('、')}`)
  return parts.join('；')
}
