import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { WorkbenchModService } from '../src/main/mods/WorkbenchModService'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Workbench bundled Mods', () => {
  test('projects the published Browser Mod as an enabled bundled capability', () => {
    const service = new WorkbenchModService(createRoot())
    expect(service.listCatalog().mods).toEqual([
      expect.objectContaining({
        id: 'velaros.browser',
        source: 'bundled',
        installed: true,
        enabled: true,
        capabilities: ['browser-surface', 'chat-tools'],
      }),
    ])
  })

  test('persists only the global Mod preference and advances generation on real changes', async () => {
    const root = createRoot()
    const service = new WorkbenchModService(root)
    const events: number[] = []
    service.subscribe((event) => events.push(event.generation))

    const unchanged = await service.setEnabled('velaros.browser', true)
    expect(unchanged.generation).toBe(1)
    expect(events).toEqual([])

    const disabled = await service.setEnabled('velaros.browser', false)
    expect(disabled.generation).toBe(2)
    expect(events).toEqual([2])
    expect(JSON.parse(readFileSync(join(root, 'mods.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      enabled: { 'velaros.browser': false },
    })

    const restored = new WorkbenchModService(root)
    expect(restored.isEnabled('velaros.browser')).toBe(false)
  })

  test('serializes concurrent mutations without losing the final preference', async () => {
    const root = createRoot()
    const service = new WorkbenchModService(root)
    await Promise.all([
      service.setEnabled('velaros.browser', false),
      service.setEnabled('velaros.browser', true),
      service.setEnabled('velaros.browser', false),
    ])

    expect(service.isEnabled('velaros.browser')).toBe(false)
    expect(new WorkbenchModService(root).isEnabled('velaros.browser')).toBe(false)
  })
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'velaros-workbench-mods-'))
  roots.push(root)
  return root
}
