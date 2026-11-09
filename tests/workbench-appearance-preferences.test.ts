import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  getWorkbenchFileTreeRowHeight,
  isWorkbenchDarkTheme,
  normalizeWorkbenchPreferences,
  readWorkbenchPreferences,
  saveWorkbenchPreferences,
  updateWorkbenchPreferences,
  WORKBENCH_PREFERENCES_CHANGED_EVENT,
  type WorkbenchPreferences,
  type WorkbenchThemeId,
} from '../src/renderer/src/models/workbenchPreferences'
import type { StorageLike } from '../src/renderer/src/support/localStorageJsonStore'

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

  test('merges preference patches with the latest durable values before notifying readers', () => {
    const key = 'velaros.workbench.preferences.v1'
    const values = new Map([[key, JSON.stringify({ ...DEFAULT_WORKBENCH_PREFERENCES, memoryEnabled: false })]])
    const storage: StorageLike = {
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => { values.set(name, value) },
      removeItem: (name) => { values.delete(name) },
    }
    const target = new EventTarget()
    const observed: WorkbenchPreferences[] = []
    target.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, () => {
      observed.push(readWorkbenchPreferences(storage))
    })

    expect(updateWorkbenchPreferences({ theme: 'dark-modern' }, storage, target as unknown as Window).ok).toBe(true)
    expect(updateWorkbenchPreferences({ diffLayout: 'split' }, storage, target as unknown as Window).ok).toBe(true)
    expect(updateWorkbenchPreferences((current) => ({ editorWordWrap: !current.editorWordWrap }), storage, target as unknown as Window).ok).toBe(true)

    const saved = readWorkbenchPreferences(storage)
    expect(saved.theme).toBe('dark-modern')
    expect(saved.diffLayout).toBe('split')
    expect(saved.editorWordWrap).toBe(true)
    expect(saved.memoryEnabled).toBe(false)
    expect(observed).toHaveLength(3)
    expect(observed[0]?.diffLayout).toBe('unified')
    expect(observed[1]?.theme).toBe('dark-modern')
    expect(observed[2]).toEqual(saved)
  })

  test('keeps durable preferences and emits no change when saving is rejected', () => {
    const key = 'velaros.workbench.preferences.v1'
    const original = JSON.stringify({ ...DEFAULT_WORKBENCH_PREFERENCES, theme: 'midnight-blue' })
    const values = new Map([[key, original]])
    const storage: StorageLike = {
      getItem: (name) => values.get(name) ?? null,
      setItem: () => { throw new Error('quota rejected') },
      removeItem: (name) => { values.delete(name) },
    }
    const target = new EventTarget()
    let changes = 0
    target.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, () => { changes += 1 })

    const result = updateWorkbenchPreferences({ diffLayout: 'split' }, storage, target as unknown as Window)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('quota rejected')
    expect(saveWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES, storage, target as unknown as Window).ok).toBe(false)
    expect(changes).toBe(0)
    expect(values.get(key)).toBe(original)
    expect(readWorkbenchPreferences(storage).diffLayout).toBe('unified')
    expect(readWorkbenchPreferences(storage).theme).toBe('midnight-blue')
  })

  test('refuses unreadable preference patches while allowing an explicit reset', () => {
    const key = 'velaros.workbench.preferences.v1'
    for (const failure of ['read', 'parse', 'shape', 'empty'] as const) {
      let raw = failure === 'parse'
        ? '{"theme":'
        : failure === 'shape' ? '[]' : failure === 'empty' ? '' : JSON.stringify({ theme: 'midnight-blue' })
      const original = raw
      let writes = 0
      const storage: StorageLike = {
        getItem: () => {
          if (failure === 'read') throw new Error('read unavailable')
          return raw
        },
        setItem: (name, value) => {
          expect(name).toBe(key)
          writes += 1
          raw = value
        },
        removeItem: () => undefined,
      }
      const target = new EventTarget()
      let changes = 0
      target.addEventListener(WORKBENCH_PREFERENCES_CHANGED_EVENT, () => { changes += 1 })

      expect(updateWorkbenchPreferences({ theme: 'warm-paper' }, storage, target as unknown as Window).ok).toBe(false)
      expect(writes).toBe(0)
      expect(changes).toBe(0)
      expect(raw).toBe(original)

      expect(saveWorkbenchPreferences(DEFAULT_WORKBENCH_PREFERENCES, storage, target as unknown as Window).ok).toBe(true)
      expect(writes).toBe(1)
      expect(changes).toBe(1)
      expect(JSON.parse(raw)).toEqual(DEFAULT_WORKBENCH_PREFERENCES)
    }
  })
})
