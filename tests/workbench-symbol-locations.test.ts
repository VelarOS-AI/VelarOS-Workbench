import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  buildWorkbenchSymbolLocationsRequest,
  groupWorkbenchSymbolLocations,
  navigateWorkbenchSymbolLocations,
  nextWorkbenchSymbolLocationIndex,
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

void test('opening a definition jump immediately preserves and highlights its call site', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'openVoxelApplicationProvider',
    origin: firstCall,
    destination: definition,
    definitions: [definition],
    references: [firstCall, secondCall],
  })
  const opened = openWorkbenchSymbolLocations(request)

  assert.equal(opened.activeLocation, definition)
  assert.equal(opened.returnLocation, firstCall)
})

void test('the panel lists locations by file, the file the search started in first', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'add',
    origin: { path: 'src/main.ts', line: 3, column: 22 },
    definitions: [{ path: 'src/math.ts', line: 1, column: 17 }],
    references: [
      { path: 'src/feature/view.ts', line: 4, column: 21 },
      { path: 'src/main.ts', line: 3, column: 22 },
      { path: 'src/math.ts', line: 1, column: 17 },
      { path: 'src/feature/view.ts', line: 4, column: 9 },
      { path: 'src/main.ts', line: 1, column: 10 },
      { path: 'src/feature/view.ts', line: 1, column: 10 },
    ],
  })
  const groups = groupWorkbenchSymbolLocations(request.items, request.origin.path)

  assert.deepEqual(
    groups.map((group) => [
      group.path,
      group.items.map((item) => `${item.location.line}:${item.location.column}:${item.kind}`),
    ]),
    [
      ['src/main.ts', ['1:10:reference', '3:22:reference']],
      ['src/feature/view.ts', ['1:10:reference', '4:9:reference', '4:21:reference']],
      // 定义那一行只列一次，带着「定义」的身份。
      ['src/math.ts', ['1:17:definition']],
    ]
  )
  assert.deepEqual(groupWorkbenchSymbolLocations([], 'src/main.ts'), [])
})

void test('the definition row shows the line text that came with the references', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'add',
    origin: { path: 'src/main.ts', line: 3, column: 22 },
    definitions: [{ path: 'src/math.ts', line: 1, column: 17 }],
    references: [
      { path: 'src/math.ts', line: 1, column: 17, preview: 'export function add(a: number) {' },
      { path: 'src/main.ts', line: 3, column: 22, preview: 'add(1)' },
    ],
  })

  assert.deepEqual(
    request.items.map((item) => [item.kind, item.location.path, item.location.preview]),
    [
      ['definition', 'src/math.ts', 'export function add(a: number) {'],
      ['reference', 'src/main.ts', 'add(1)'],
    ]
  )
})

void test('arrow keys walk the list without wrapping around', () => {
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 0, 1), 1)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 2, 1), 2)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 1, -1), 0)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 0, -1), 0)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 1, 'first'), 0)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, 1, 'last'), 2)
  // 焦点还不在任何一行上：往下从头起，往上从尾起。
  assert.equal(nextWorkbenchSymbolLocationIndex(3, -1, 1), 0)
  assert.equal(nextWorkbenchSymbolLocationIndex(3, -1, -1), 2)
  assert.equal(nextWorkbenchSymbolLocationIndex(0, -1, 1), -1)
})

void test('a references list takes the keyboard when it opens and gives it back after a jump', () => {
  const request = buildWorkbenchSymbolLocationsRequest({
    symbol: 'openVoxelApplicationProvider',
    origin: firstCall,
    definitions: [definition],
    references: [firstCall, secondCall],
    focusList: true,
  })
  const opened = openWorkbenchSymbolLocations(request)
  assert.equal(opened.focusList, true)
  // 跳过去之后键盘焦点留在编辑器里：面板跟着重新出现时不再抢。
  assert.equal(navigateWorkbenchSymbolLocations(opened, secondCall).focusList, false)

  // 跳到定义顺带列出来的那份不抢焦点。
  const quiet = buildWorkbenchSymbolLocationsRequest({
    symbol: 'openVoxelApplicationProvider',
    origin: firstCall,
    definitions: [definition],
    references: [],
  })
  assert.equal(openWorkbenchSymbolLocations(quiet).focusList, undefined)
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
