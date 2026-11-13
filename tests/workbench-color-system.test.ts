import { describe, expect, test } from 'bun:test'

import {
  getWorkbenchColorTokens,
  getWorkbenchNativeAppearance,
  type WorkbenchAccent,
  workbenchColorContrast,
  type WorkbenchThemeId,
} from '../src/shared/workbenchAppearance'

const themes: WorkbenchThemeId[] = ['light-modern', 'dark-modern', 'warm-paper', 'midnight-blue']
const accents: WorkbenchAccent[] = [
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'rose',
  'violet',
  'slate',
]

describe('Workbench semantic color system', () => {
  for (const theme of themes) {
    for (const accent of accents) {
      test(`${theme}/${accent}: readable ink, accents, statuses and tooltips`, () => {
        const tokens = getWorkbenchColorTokens(theme, accent)
        const surfaces = ['--workbench-bg', '--workbench-surface-muted', '--workbench-control-bg']
        for (const foreground of [
          '--workbench-text',
          '--workbench-text-secondary',
          '--workbench-text-muted',
          '--workbench-theme-color',
        ]) {
          for (const surface of surfaces) {
            expect(
              workbenchColorContrast(tokens[foreground]!, tokens[surface]!)
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
        expect(
          workbenchColorContrast(
            tokens['--workbench-tooltip-fg']!,
            tokens['--workbench-tooltip-bg']!
          )
        ).toBeGreaterThanOrEqual(4.5)
        for (const surface of ['--workbench-accent-solid', '--workbench-accent-solid-hover']) {
          expect(
            workbenchColorContrast(tokens['--workbench-accent-contrast']!, tokens[surface]!)
          ).toBeGreaterThanOrEqual(4.5)
        }
        expect(
          workbenchColorContrast(
            tokens[`--workbench-accent-${accent}`]!,
            tokens[`--workbench-accent-${accent}-contrast`]!
          )
        ).toBeGreaterThanOrEqual(4.5)
        for (const status of ['green', 'red', 'amber', 'blue', 'orange']) {
          expect(
            workbenchColorContrast(
              tokens[`--status-${status}`]!,
              tokens[`--status-${status}-soft`]!
            )
          ).toBeGreaterThanOrEqual(4.5)
        }
        expect(tokens['--workbench-tooltip-bg']).not.toBe(tokens['--workbench-tooltip-fg'])
        expect(tokens['--workbench-text']).not.toBe(tokens['--workbench-text-secondary'])
        expect(tokens['--workbench-text-secondary']).not.toBe(tokens['--workbench-text-muted'])
        expect(tokens['--workbench-bg']).toBe(getWorkbenchNativeAppearance(theme).backgroundColor)
        expect(tokens['--workbench-test-fg']).toBe(tokens['--status-orange']!)
        expect(tokens['--workbench-run-fg']).toBe(tokens['--status-green']!)
      })
    }
  }

  test('each accent has separate light and dark ink rather than sharing one RGB value', () => {
    for (const accent of accents) {
      const light = getWorkbenchColorTokens('light-modern', accent)
      const dark = getWorkbenchColorTokens('dark-modern', accent)
      expect(light['--workbench-theme-color']).not.toBe(dark['--workbench-theme-color'])
      expect(light['--workbench-text']).not.toBe(light['--primary'])
      expect(dark['--workbench-text']).not.toBe(dark['--primary'])
    }
  })
})
