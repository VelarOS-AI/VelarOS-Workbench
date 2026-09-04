import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, test } from 'bun:test'

import { findWorkbenchBrowserMod } from '../src/renderer/src/runtime/standaloneWorkbenchMods'
import type { WorkbenchModCatalog } from '../src/shared/workbenchMods'

function catalog(enabled: boolean): WorkbenchModCatalog {
  return {
    generation: 4,
    mods: [{
      id: 'velaros.browser',
      displayName: 'VelarOS Browser',
      description: 'Browser tools',
      version: '0.2.6',
      source: 'bundled',
      installed: true,
      enabled,
      defaultEnabled: true,
      capabilities: ['browser-surface', 'chat-tools'],
    }],
  }
}

describe('Workbench Mods renderer', () => {
  test('projects the bundled Browser Mod from the main-process catalog', () => {
    assert.equal(findWorkbenchBrowserMod(catalog(true))?.enabled, true)
    assert.equal(findWorkbenchBrowserMod(catalog(false))?.enabled, false)
    assert.equal(findWorkbenchBrowserMod({ generation: 1, mods: [] }), null)
  })

  test('renders global Browser Mod control through the Mods bridge', () => {
    const settings = readFileSync(
      new URL('../src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx', import.meta.url),
      'utf8'
    )
    const mods = readFileSync(
      new URL('../src/renderer/src/runtime/standaloneWorkbenchMods.ts', import.meta.url),
      'utf8'
    )
    const chat = readFileSync(
      new URL('../src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx', import.meta.url),
      'utf8'
    )
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
    const windowTypes = readFileSync(
      new URL('../src/shared/workbenchWindow.d.ts', import.meta.url),
      'utf8'
    )

    assert.match(settings, /setWorkbenchBrowserModEnabled\(enabled\)/u)
    assert.match(settings, /settingsBrowserModDescription/u)
    assert.match(mods, /window\.velarosWorkbenchMods/u)
    assert.match(preload, /exposeInMainWorld\('velarosWorkbenchMods', modBridge\)/u)
    assert.match(windowTypes, /velarosWorkbenchMods: WorkbenchModBridge/u)
    assert.doesNotMatch(chat, /setWorkbenchBrowserAttached|capabilityControls.*velaros\.browser/us)
  })
})
