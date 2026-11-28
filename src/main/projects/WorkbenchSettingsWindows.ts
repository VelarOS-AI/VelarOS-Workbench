import type { BrowserWindow, WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

interface SettingsWindowsOptions {
  windows: Pick<
    WorkbenchWindowManager,
    'getWindowForWebContents' | 'registerAuxiliaryWindow' | 'sendMenuCommandToWindow'
  >
  createWindow: (owner: BrowserWindow) => BrowserWindow
  loadWindow: (window: BrowserWindow) => void
}

/** One modeless settings window per project owner; never create a second workspace. */
export class WorkbenchSettingsWindows {
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly initialized = new WeakSet<BrowserWindow>()

  public constructor(private readonly options: SettingsWindowsOptions) {}

  public open(sender: WebContents): void {
    const owner = this.options.windows.getWindowForWebContents(sender)
    if (!owner || owner.isDestroyed())
      throw new AppError('PERMISSION', 'Settings require an application window')
    const ownerId = owner.webContents.id
    const existing = this.windows.get(ownerId)
    if (existing && !existing.isDestroyed()) {
      if (!this.initialized.has(existing)) return
      if (existing.isMinimized()) existing.restore()
      if (!existing.isVisible()) existing.show()
      existing.focus()
      return
    }
    const window = this.options.createWindow(owner)
    this.windows.set(ownerId, window)
    this.options.windows.registerAuxiliaryWindow(owner.webContents, window)
    window.once('closed', () => {
      if (this.windows.get(ownerId) === window) this.windows.delete(ownerId)
    })
    this.options.loadWindow(window)
  }

  /** 显示设置前，等渲染器按已保存的主题绘制。 */
  public ready(sender: WebContents): void {
    const window = this.findSettingsWindow(sender)
    if (!window) throw new AppError('PERMISSION', 'Not a settings window')
    if (this.initialized.has(window)) return

    this.initialized.add(window)
    window.show()
    window.focus()
  }

  public close(sender: WebContents): void {
    const window = [...this.windows.values()].find(
      (candidate) => candidate.webContents.id === sender.id
    )
    if (window && !window.isDestroyed()) window.close()
  }

  public exitProject(sender: WebContents): void {
    this.assertSettingsWindow(sender)
    const owner = this.options.windows.getWindowForWebContents(sender)
    // The project renderer still owns its unsaved-editor check.
    this.options.windows.sendMenuCommandToWindow(owner, 'close-project')
  }

  public assertSettingsWindow(sender: WebContents): void {
    if (!this.findSettingsWindow(sender))
      throw new AppError('PERMISSION', 'Not a settings window')
  }

  private findSettingsWindow(sender: WebContents): BrowserWindow | undefined {
    return [...this.windows.values()].find(
      (window) => !window.isDestroyed() && window.webContents.id === sender.id
    )
  }

  public dispose(): void {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.close()
    this.windows.clear()
  }
}
