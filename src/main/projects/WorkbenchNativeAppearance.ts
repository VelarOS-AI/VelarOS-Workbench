import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  getWorkbenchNativeAppearance,
  isWorkbenchTheme,
  type WorkbenchThemeId,
} from '../../shared/workbenchAppearance'

interface AppearanceWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
}

interface NativeAppearanceOptions {
  file: string
  nativeTheme: { themeSource: 'system' | 'light' | 'dark' }
  windows: () => readonly AppearanceWindow[]
}

/** Persist only the native appearance hint; renderer preferences remain authoritative. */
export class WorkbenchNativeAppearance {
  private theme: WorkbenchThemeId = 'light-modern'

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

  public setTheme(theme: unknown): void {
    if (!isWorkbenchTheme(theme)) throw new TypeError('Invalid Workbench theme')
    if (theme === this.theme) return
    this.theme = theme
    this.options.nativeTheme.themeSource = getWorkbenchNativeAppearance(theme).colorScheme
    for (const window of this.options.windows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(this.backgroundColor)
    }
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.tmp`
    writeFileSync(temporary, JSON.stringify({ schema: 1, theme }))
    renameSync(temporary, this.options.file)
  }
}
