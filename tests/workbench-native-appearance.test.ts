import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { WorkbenchNativeAppearance } from '../src/main/projects/WorkbenchNativeAppearance'
import { getWorkbenchNativeAppearance } from '../src/shared/workbenchAppearance'

test('native chrome follows the app theme across windows and the next launch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wb-native-appearance-'))
  const file = join(directory, 'appearance.json')
  const nativeTheme: { themeSource: 'system' | 'light' | 'dark' } = { themeSource: 'system' }
  const backgrounds: string[] = []
  const window = {
    isDestroyed: () => false,
    setBackgroundColor: (color: string) => backgrounds.push(color),
  }
  const destroyed = {
    isDestroyed: () => true,
    setBackgroundColor: () => {
      throw new Error('Destroyed window was touched')
    },
  }
  try {
    const appearance = new WorkbenchNativeAppearance({
      file,
      nativeTheme,
      windows: () => [window, window, destroyed],
    })
    appearance.setTheme('midnight-blue')
    expect(nativeTheme.themeSource).toBe('dark')
    expect(backgrounds).toEqual([appearance.backgroundColor, appearance.backgroundColor])
    expect(appearance.backgroundColor).toBe(
      getWorkbenchNativeAppearance('midnight-blue').backgroundColor
    )
    const saved = readFileSync(file, 'utf8')
    expect(() => appearance.setTheme('arbitrary-color')).toThrow('Invalid Workbench theme')
    expect(readFileSync(file, 'utf8')).toBe(saved)
    nativeTheme.themeSource = 'system'
    const relaunched = new WorkbenchNativeAppearance({ file, nativeTheme, windows: () => [window] })
    expect(nativeTheme.themeSource).toBe('dark')
    expect(relaunched.backgroundColor).toBe(appearance.backgroundColor)
    relaunched.setTheme('warm-paper')
    expect(nativeTheme.themeSource).toBe('light')
    expect(JSON.parse(readFileSync(file, 'utf8')).theme).toBe('warm-paper')
    writeFileSync(file, '{"theme":"unrecognized"}')
    new WorkbenchNativeAppearance({ file, nativeTheme, windows: () => [] })
    expect(nativeTheme.themeSource).toBe('light')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
