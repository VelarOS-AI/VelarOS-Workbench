import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildWorkbenchSymbolLocationsRequest,
  navigateWorkbenchSymbolLocations,
  openWorkbenchSymbolLocations,
  sameWorkbenchSymbolLocation,
  workbenchSymbolLocationDisplayPath,
} from '../src/renderer/src/models/editor/workbenchSymbolLocations'

const origin = { path: 'src/application.vel', line: 84, column: 14 }
const definition = { path: 'src/application.vel', line: 84, column: 14 }
const firstCall = { path: 'src/modules/world.vel', line: 10, column: 65 }
const secondCall = { path: 'src/modules/world.vel', line: 25, column: 79 }

void test('call-site panels deduplicate the definition and keep definitions first', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'openVoxelApplicationProvider',
    origin,
    definitions: [definition],
    references: [secondCall, definition, firstCall],
  })

  assert.deepEqual(
    request.items.map((item) => [item.kind, item.location]),
    [
      ['definition', definition],
      ['reference', firstCall],
      ['reference', secondCall],
    ]
  )
})

void test('every jump promotes the previous call site to the highlighted return slot', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'openVoxelApplicationProvider',
    origin: firstCall,
    definitions: [definition],
    references: [firstCall, secondCall],
  })
  const opened = openWorkbenchSymbolLocations(request)
  const atDefinition = navigateWorkbenchSymbolLocations(opened, definition)
  assert.equal(atDefinition.returnLocation, firstCall)
  assert.equal(atDefinition.activeLocation, definition)

  const returned = navigateWorkbenchSymbolLocations(atDefinition, firstCall)
  assert.equal(returned.returnLocation, definition)
  assert.equal(returned.activeLocation, firstCall)
  assert.equal(sameWorkbenchSymbolLocation(returned.activeLocation, firstCall), true)
})

void test('panel paths stay project-relative for display', () => {
  assert.equal(
    workbenchSymbolLocationDisplayPath(
      '/Users/mac/Documents/ChatGPT/openvoxel',
      '/Users/mac/Documents/ChatGPT/openvoxel/apps/server/src/application.vel'
    ),
    'apps/server/src/application.vel'
  )
  assert.equal(
    workbenchSymbolLocationDisplayPath('C:\\openvoxel', 'C:\\openvoxel\\src\\application.vel'),
    'src/application.vel'
  )
})
