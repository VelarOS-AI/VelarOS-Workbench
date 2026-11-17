import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BrowserWindowConstructorOptions } from 'electron'

import {
  getWorkbenchNativeAppearance,
  isWorkbenchTheme,
  type WorkbenchThemeId,
} from '../../shared/workbenchAppearance'

interface AppearanceWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setTitleBarOverlay?(options: { color: string; symbolColor: string; height: number }): void
}

interface NativeAppearanceOptions {
  file: string
  nativeTheme: { themeSource: 'system' | 'light' | 'dark' }
  windows: () => readonly AppearanceWindow[]
}

/** Persist only the native appearance hint; renderer preferences remain authoritative. */
export class WorkbenchNativeAppearance {
  private theme: WorkbenchThemeId = 'light-modern'
  private readonly captionWindows = new WeakSet<AppearanceWindow>()

  public constructor(private readonly options: NativeAppearanceOptions) {
    try {
      const stored: unknown = JSON.parse(readFileSync(options.file, 'utf8'))
      if (
        stored &&
        typeof stored === 'object' &&
        'theme' in stored &&
        isWorkbenchTheme(stored.theme)
      )
        this.theme = stored.theme
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[workbench-appearance] Could not read the native appearance hint', error)
    }
    options.nativeTheme.themeSource = getWorkbenchNativeAppearance(this.theme).colorScheme
  }

  public get backgroundColor(): string {
    return getWorkbenchNativeAppearance(this.theme).backgroundColor
  }

  public get titleBarOverlay(): { color: string; symbolColor: string; height: number } {
    const appearance = getWorkbenchNativeAppearance(this.theme)
    return {
      color: appearance.backgroundColor,
      symbolColor: appearance.foregroundColor,
      height: 32,
    }
  }

  public frameOptions(
    platform: NodeJS.Platform,
    settings = false
  ): BrowserWindowConstructorOptions {
    if (platform === 'win32')
      return { frame: true, titleBarStyle: 'hidden', titleBarOverlay: this.titleBarOverlay }
    return {
      frame: true,
      titleBarStyle: platform === 'darwin' && !settings ? 'hiddenInset' : 'default',
    }
  }

  /** Window Controls Overlay retains Windows' own minimize/maximize/close controls. */
  public registerCaptionWindow(window: AppearanceWindow): void {
    this.captionWindows.add(window)
    window.setTitleBarOverlay?.(this.titleBarOverlay)
  }

  public setTheme(theme: unknown): void {
    if (!isWorkbenchTheme(theme)) throw new TypeError('Invalid Workbench theme')
    if (theme === this.theme) return
    this.theme = theme
    this.options.nativeTheme.themeSource = getWorkbenchNativeAppearance(theme).colorScheme
    for (const window of this.options.windows()) {
      if (window.isDestroyed()) continue
      window.setBackgroundColor(this.backgroundColor)
      if (this.captionWindows.has(window)) window.setTitleBarOverlay?.(this.titleBarOverlay)
    }
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.tmp`
    writeFileSync(temporary, JSON.stringify({ schema: 1, theme }))
    renameSync(temporary, this.options.file)
  }
}
