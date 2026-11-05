import {
  BrowserWindow,
  net,
  type Session,
  session as electronSession,
  type WebContents,
} from 'electron'

import { numberOrNull } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'
import type { WebPage, WebSpacePort } from '@velaros-ai/velaros/web'

import { WorkbenchWebSearchPartition } from '../../shared/workbenchBrowser'

/** 无头页面的窗口尺寸：按常见桌面宽度排版，搜索结果页给的是桌面版。 */
const WebSearchPageSize = { width: 1280, height: 900 } as const
/** 同时最多开几个无头页面；多出来的排队。 */
const MaxOpenPages = 4
/** 一次加载的兜底上限：平时由 `velaros:web` 按它自己的时限触发 signal 停下，这里只防页面永远不停。 */
const LoadBackstopMs = 45_000
/** 导航被页面自己的跳转打断（ERR_ABORTED）之后，最多再等多久让它停下来。 */
const RedirectSettleMs = 8_000
/** Chromium 的「导航被取消」：客户端跳转常见，页面其实在往下走。 */
const ErrAborted = -3

/**
 * `velaros:web` 的无头页面（与 Desktop 同一做法）：不显示的窗口，独立分区——不带用户在内置浏览器里的登录，也不
 * 往里留浏览痕迹；权限请求一律拒绝，弹窗一律不开，静音。同时最多开 MaxOpenPages 个，多的排队；关页面就是释放。
 * 搜索引擎的跳转链接在同一个分区里问一跳拿真实地址。
 */
export class WorkbenchWebSearchPages implements Pick<WebSpacePort, 'openPage' | 'resolveRedirect'> {
  private open = 0
  private readonly waiting: Array<() => void> = []
  private preparedSession: Nullable<Session> = null

  /** 开一个无头页面；前面的页面没关完就排队，取消了就不开。 */
  public async openPage(signal: AbortSignal): Promise<WebPage> {
    await this.acquire(signal)
    try {
      return this.createPage()
    } catch (error) {
      this.release()
      throw error
    }
  }

  /** 跟一跳服务端跳转、不加载目标：同一个分区里发请求，读跳转的 Location；不是跳转交回 null。 */
  public resolveRedirect(url: string, signal: AbortSignal): Promise<Nullable<string>> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const request = net.request({
        url,
        redirect: 'manual',
        session: this.prepareSession(),
        useSessionCookies: true,
      })
      const finish = (): void => signal.removeEventListener('abort', abort)
      const abort = (): void => {
        finish()
        request.abort()
        reject(AppError.from(signal.reason))
      }
      signal.addEventListener('abort', abort, { once: true })
      request.on('redirect', (_status, _method, location) => {
        finish()
        resolve(location)
        request.abort()
      })
      request.on('response', (response) => {
        finish()
        resolve(null)
        response.on('data', () => undefined)
      })
      request.on('error', (error) => {
        finish()
        reject(AppError.from(error))
      })
      request.end()
    })
  }

  private createPage(): WebPage {
    const window = new BrowserWindow({
      ...WebSearchPageSize,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: this.prepareSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        backgroundThrottling: false,
      },
    })
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      if (!window.isDestroyed()) window.destroy()
      this.release()
    }
    window.on('closed', close)
    return {
      load: (url, signal) => loadPage(contents, url, signal),
      evaluate: <T>(expression: string) =>
        contents.executeJavaScript(expression, true) as Promise<T>,
      url: () => (contents.isDestroyed() ? '' : contents.getURL()),
      close,
    }
  }

  /** 分区第一次用时装上：权限一律拒绝，用户代理去掉 Electron 与应用名，搜索引擎给的是普通桌面版页面。 */
  private prepareSession(): Session {
    if (this.preparedSession) return this.preparedSession
    const session = electronSession.fromPartition(WorkbenchWebSearchPartition)
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.setUserAgent(
      session
        .getUserAgent()
        .replace(/\s+Electron\/\S+/u, '')
        .replace(/\s+velaros[\w-]*\/\S+/iu, '')
    )
    this.preparedSession = session
    return session
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.open < MaxOpenPages) {
      this.open += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', abort)
        this.open += 1
        resolve()
      }
      const abort = (): void => {
        const index = this.waiting.indexOf(grant)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(AppError.from(signal.reason))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiting.push(grant)
    })
  }

  private release(): void {
    this.open -= 1
    this.waiting.shift()?.()
  }
}

/**
 * 打开地址，等到页面加载完。页面自己的客户端跳转会把这次导航打断（ERR_ABORTED），那不算失败：
 * 再等它停下来。signal 触发（`velaros:web` 的时限到了、调用取消了）就停止加载并失败；兜底上限到了也失败。
 */
async function loadPage(contents: WebContents, url: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const timers = new TimerScope({ name: 'WorkbenchWebSearchPages.load' })
  let stop = (): void => undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      if (!contents.isDestroyed()) contents.stop()
      reject(AppError.from(signal.reason))
    }
    timers.after(
      LoadBackstopMs,
      () => reject(new AppError('TIMEOUT', `网页 ${LoadBackstopMs / 1000} 秒还没加载完：${url}`)),
      { label: 'web-page-load-backstop' }
    )
    signal.addEventListener('abort', abort, { once: true })
    stop = () => signal.removeEventListener('abort', abort)
  })
  try {
    await Promise.race([
      contents.loadURL(url).catch(async (error: unknown) => {
        if (readLoadErrorCode(error) !== ErrAborted) throw error
        await waitForStop(contents, timers)
      }),
      stopped,
    ])
  } finally {
    stop()
    timers.dispose()
  }
}

/** loadURL 的失败带 Chromium 的错误码（负数）；读不出来是 null。 */
function readLoadErrorCode(error: unknown): Nullable<number> {
  return numberOrNull((error as Nullable<{ errno?: unknown }>)?.errno)
}

/** 等页面停止加载；已经停了立刻回，最多等 RedirectSettleMs。 */
function waitForStop(contents: WebContents, timers: TimerScope): Promise<void> {
  if (contents.isDestroyed() || !contents.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      settle.cancel()
      if (!contents.isDestroyed()) contents.removeListener('did-stop-loading', done)
      resolve()
    }
    const settle = timers.after(RedirectSettleMs, done, { label: 'web-page-redirect-settle' })
    contents.once('did-stop-loading', done)
  })
}
