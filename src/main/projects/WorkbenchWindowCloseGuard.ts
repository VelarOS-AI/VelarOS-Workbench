/**
 * 关窗与退出前的「未保存改动」闸门。
 *
 * renderer 随时报来窗口里有没有未保存的编辑器改动。有改动的窗口被关（红绿灯、⇧⌘W、系统关窗）时，
 * 这里拦下关闭，把请求交给它的 renderer：能存的先存掉，存不下的再问用户「保存全部 / 不保存 / 取消」。
 * 答「可以关」才真的关；取消就作罢。退出应用（⌘Q、Dock 退出）先于一切清理逐个问一遍有改动的
 * 窗口，都答应了才继续退出——否则用户点了取消，窗口还开着，IPC 与子进程却已经收掉了。
 */
import {
  WorkbenchWindowCloseChannels,
  type WorkbenchWindowCloseReason,
  type WorkbenchWindowCloseRequest,
  type WorkbenchWindowCloseResponse,
} from '../../shared/workbenchWindowClose'

interface WorkbenchCloseGuardedWebContents {
  readonly id: number
  isCrashed(): boolean
  isDestroyed(): boolean
  send(channel: string, payload: WorkbenchWindowCloseRequest): void
  on(event: 'did-navigate', listener: () => void): unknown
}

/** 闸门用到的那部分 BrowserWindow（测试里用假的窗口）。 */
export interface WorkbenchCloseGuardedWindow {
  readonly webContents: WorkbenchCloseGuardedWebContents
  close(): void
  focus(): void
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  setDocumentEdited(edited: boolean): void
  show(): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  once(event: 'closed', listener: () => void): unknown
}

interface WorkbenchCloseGuardRecord {
  window: WorkbenchCloseGuardedWindow
  /** renderer 最近一次报来的：编辑器里有没有未保存的改动。 */
  unsaved: boolean
  /** 这次关闭 / 退出已经得到 renderer 的同意。 */
  approved: boolean
  /** 正在等 renderer 答复的请求号。 */
  pendingRequestId: Nullable<number>
}

export class WorkbenchWindowCloseGuard {
  private readonly records = new Map<number, WorkbenchCloseGuardRecord>()
  private nextRequestId = 0
  private quitRequested = false
  private shuttingDown = false

  /** @param quit 继续退出应用（`app.quit()`）；某个窗口答应之后用它接着走退出流程。 */
  constructor(
    private readonly quit: () => void,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  public install(window: WorkbenchCloseGuardedWindow): void {
    const webContentsId = window.webContents.id
    const record: WorkbenchCloseGuardRecord = {
      window,
      unsaved: false,
      approved: false,
      pendingRequestId: null,
    }
    this.records.set(webContentsId, record)

    window.on('close', (event) => {
      if (!this.shouldAsk(record)) return

      event.preventDefault()
      this.requestClose(record, this.quitRequested ? 'quit' : 'close')
    })
    // 页面重新加载：旧页面的改动与没答复的请求都作废，新页面会自己再报。
    window.webContents.on('did-navigate', () => {
      record.unsaved = false
      record.approved = false
      record.pendingRequestId = null
    })
    window.once('closed', () => {
      this.records.delete(webContentsId)
    })
  }

  /** renderer 报来这个窗口有没有未保存的改动；macOS 顺带在关闭按钮上标出来。 */
  public setUnsavedChanges(webContentsId: number, unsaved: boolean): void {
    const record = this.records.get(webContentsId)
    if (!record) return

    record.unsaved = unsaved
    if (this.platform === 'darwin' && !record.window.isDestroyed())
      record.window.setDocumentEdited(unsaved)
  }

  /** renderer 对关闭请求的答复。 */
  public resolveCloseRequest(webContentsId: number, response: WorkbenchWindowCloseResponse): void {
    const record = this.records.get(webContentsId)
    if (!record || record.pendingRequestId !== response.id) return

    record.pendingRequestId = null
    if (!response.proceed) {
      // 用户取消（或有文件没存下）：这次退出作罢。别的窗口先前的同意一并收回——它们还开着，
      // 之后再关得重新问。
      this.quitRequested = false
      for (const other of this.records.values()) other.approved = false
      return
    }

    record.approved = true
    if (this.quitRequested) {
      this.quit()
      return
    }
    if (!record.window.isDestroyed()) record.window.close()
  }

  /**
   * 应用要退出（before-quit）。还有有改动、没答应关的窗口，就拦下这次退出，先去问它，返回 true；
   * 都没有了返回 false，此后的关窗一律放行，好让退出流程把窗口关完。
   */
  public holdQuit(): boolean {
    if (this.shuttingDown) return false

    const pending = [...this.records.values()].find((record) => this.shouldAsk(record))
    if (!pending) {
      this.shuttingDown = true
      return false
    }

    this.quitRequested = true
    this.requestClose(pending, 'quit')
    return true
  }

  private shouldAsk(record: WorkbenchCloseGuardRecord): boolean {
    const contents = record.window.webContents
    return (
      !this.shuttingDown
      && record.unsaved
      && !record.approved
      && !record.window.isDestroyed()
      && !contents.isDestroyed()
      // renderer 崩了就没人能回答：放行，不能让窗口永远关不掉。
      && !contents.isCrashed()
    )
  }

  private requestClose(record: WorkbenchCloseGuardRecord, reason: WorkbenchWindowCloseReason): void {
    const { window } = record
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    // 已经在问了（又点了一次关闭、又按了一次退出）：等那一次的答复。
    if (record.pendingRequestId !== null) return

    this.nextRequestId += 1
    record.pendingRequestId = this.nextRequestId
    window.webContents.send(WorkbenchWindowCloseChannels.closeRequested, {
      id: record.pendingRequestId,
      reason,
    })
  }
}
