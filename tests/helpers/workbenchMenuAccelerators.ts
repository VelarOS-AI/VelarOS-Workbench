/**
 * 应用菜单占着的键（`src/main/projects/ProjectHubMenu.ts`）：键位方案的表不去盖它们。
 *
 * 菜单里直接写了 `accelerator` 的从源码里读；`role` 带来的那些照 Electron 的 `menu-item-roles` 列在这里
 * （Electron 把这张表编进了二进制，读不到）。菜单里出现了这里没列的 role 会报出来，提醒把它的键补上。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  keymapTestChordSignature,
  type KeymapTestPlatform,
  parseKeymapTestChord,
} from './workbenchKeymapChords'

export interface WorkbenchMenuKey {
  /** 这个键在这个平台上的样子（与 `keymapTestSignature` 同一种写法）。 */
  signature: string
  /** 菜单里的哪一项。 */
  item: string
}

type RoleKeys = (platform: KeymapTestPlatform) => ReadonlyArray<readonly [item: string, accelerator: string]>

const mac = (platform: KeymapTestPlatform): boolean => platform === 'MacIntel'

/** Electron 给各个 role 的默认键。 */
const RoleAccelerators: Readonly<Record<string, RoleKeys>> = {
  appMenu: (platform) =>
    mac(platform)
      ? [
          ['hide', 'Command+H'],
          ['hideOthers', 'Command+Alt+H'],
          ['quit', 'Command+Q'],
        ]
      : [],
  editMenu: (platform) => [
    ['undo', 'CommandOrControl+Z'],
    ['redo', platform === 'Win32' ? 'Control+Y' : 'Shift+CommandOrControl+Z'],
    ['cut', 'CommandOrControl+X'],
    ['copy', 'CommandOrControl+C'],
    ['paste', 'CommandOrControl+V'],
    ...(mac(platform) ? ([['pasteAndMatchStyle', 'Cmd+Option+Shift+V']] as const) : []),
    ['selectAll', 'CommandOrControl+A'],
  ],
  reload: () => [['reload', 'CmdOrCtrl+R']],
  forceReload: () => [['forceReload', 'Shift+CmdOrCtrl+R']],
  toggleDevTools: (platform) => [
    ['toggleDevTools', mac(platform) ? 'Alt+Command+I' : 'Ctrl+Shift+I'],
  ],
  togglefullscreen: (platform) => [
    ['togglefullscreen', mac(platform) ? 'Control+Command+F' : 'F11'],
  ],
  minimize: () => [['minimize', 'CommandOrControl+M']],
  // 没有默认键的。
  window: () => [],
  zoom: () => [],
  front: () => [],
}

/** Electron 的写法（`CmdOrCtrl+Shift+N`）换成键位表的写法；`Plus` 是 `=` 那颗键，带不带 Shift 都算。 */
function acceleratorChords(accelerator: string): string[] {
  const parts = accelerator.split('+').filter(Boolean)
  const endsWithPlus = accelerator.endsWith('++')
  const key = endsWithPlus ? '+' : (parts.pop() ?? '')
  const modifiers = parts.map((part) => {
    switch (part.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
      case 'command':
      case 'cmd':
        return 'Mod'
      case 'control':
      case 'ctrl':
        return 'Ctrl'
      case 'alt':
      case 'option':
        return 'Alt'
      case 'shift':
        return 'Shift'
      default:
        throw new Error(`Unknown accelerator modifier "${part}" in "${accelerator}"`)
    }
  })
  if (key.toLowerCase() === 'plus' || key === '+')
    return [[...modifiers, '='].join('+'), [...modifiers, 'Shift', '='].join('+')]
  return [[...modifiers, key].join('+')]
}

function menuSource(): string {
  return readFileSync(resolve(process.cwd(), 'src/main/projects/ProjectHubMenu.ts'), 'utf8')
}

/** 菜单源码里用到的 role。 */
export function listWorkbenchMenuRoles(): string[] {
  return [...new Set([...menuSource().matchAll(/\brole: '([^']+)'/gu)].map(([, role]) => role!))]
}

/** 这个平台上应用菜单占着的键。 */
export function listWorkbenchMenuKeys(platform: KeymapTestPlatform): WorkbenchMenuKey[] {
  const source = menuSource()
  const keys: Array<readonly [item: string, accelerator: string]> = [
    ...[...source.matchAll(/accelerator: '([^']+)'/gu)].map(
      ([, accelerator]) => [accelerator!, accelerator!] as const
    ),
    ...listWorkbenchMenuRoles().flatMap((role) => {
      const roleKeys = RoleAccelerators[role]
      if (!roleKeys) throw new Error(`Menu role "${role}" has no accelerator entry in the test helper`)
      // macOS 才有的菜单项在别的平台上不存在。
      return (role === 'appMenu' || role === 'front') && !mac(platform) ? [] : roleKeys(platform)
    }),
  ]
  return keys.flatMap(([item, accelerator]) =>
    acceleratorChords(accelerator).map((chord) => ({
      item,
      signature: keymapTestChordSignature(parseKeymapTestChord(chord, platform)),
    }))
  )
}
