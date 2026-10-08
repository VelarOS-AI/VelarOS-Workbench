import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  getWorkbenchFileTreeRowHeight,
  isWorkbenchDarkTheme,
  normalizeWorkbenchPreferences,
  type WorkbenchThemeId,
} from '../src/renderer/src/models/workbenchPreferences'

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('Workbench appearance preferences', () => {
  test('offers two neutral themes and two visually distinct color themes', () => {
    expect(normalizeWorkbenchPreferences({ theme: 'warm-paper' }).theme).toBe('warm-paper')
    expect(normalizeWorkbenchPreferences({ theme: 'midnight-blue' }).theme).toBe('midnight-blue')
    expect(isWorkbenchDarkTheme('warm-paper')).toBe(false)
    expect(isWorkbenchDarkTheme('midnight-blue')).toBe(true)

    expect(normalizeWorkbenchPreferences({
      theme: 'light-plus' as WorkbenchThemeId,
    }).theme).toBe('light-modern')
    expect(normalizeWorkbenchPreferences({
      theme: 'dark-plus' as WorkbenchThemeId,
    }).theme).toBe('dark-modern')

    const shellStyles = source('src/renderer/src/styles/01-shell.module.css')
    expect(shellStyles).toContain("data-workbench-theme='warm-paper'")
    expect(shellStyles).toContain("data-workbench-theme='midnight-blue'")
  })

  test('density changes virtual rows and visible chrome geometry', () => {
    expect(getWorkbenchFileTreeRowHeight('compact')).toBe(20)
    expect(getWorkbenchFileTreeRowHeight('balanced')).toBe(23)
    expect(getWorkbenchFileTreeRowHeight('comfortable')).toBe(27)

    const shellStyles = source('src/renderer/src/styles/01-shell.module.css')
    const chromeStyles = source('src/renderer/src/styles/02-chrome-top.module.css')
    const settingsStyles = source('src/renderer/src/styles/14-settings.module.css')
    const embeddedKernel = source(
      'src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx'
    )

    expect(shellStyles).toContain('--workbench-topbar-height: 32px')
    expect(shellStyles).toContain('--workbench-topbar-height: 42px')
    expect(chromeStyles).toContain('min-height: var(--workbench-topbar-height)')
    expect(settingsStyles).toContain('min-height: var(--workbench-settings-row-height)')
    expect(embeddedKernel).toContain('data-workbench-density={embeddedChrome.density}')
    expect(embeddedKernel).not.toContain('data-workbench-density="compact"')
  })
})
