import type { BrowserWindow, Input } from 'electron'

import {
  WorkbenchProjectHubChannels,
  type WorkbenchProjectHubMenuCommand,
} from '../../shared/projectHub'

export type WorkbenchEditorZoomMenuCommand = Extract<
  WorkbenchProjectHubMenuCommand,
  'zoom-editor-in' | 'zoom-editor-out' | 'zoom-editor-reset'
>

type WorkbenchEditorZoomInput = Pick<
  Input,
  'alt' | 'code' | 'control' | 'key' | 'meta' | 'type'
>

/**
 * 把 Electron 的主修饰键缩放输入翻译成“编辑器字号”命令。
 *
 * 同时识别主键盘与数字键盘；`=` 也算放大，兼容无需 Shift 的原生 IDE 习惯。
 * Alt 组合保留给输入法与系统快捷键，不在这里截获。
 */
export function getWorkbenchEditorZoomMenuCommand(
  input: WorkbenchEditorZoomInput
): WorkbenchEditorZoomMenuCommand | null {
  if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return null

  if (input.key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract')
    return 'zoom-editor-out'
  if (
    input.key === '+' ||
    input.key === '=' ||
    input.code === 'Equal' ||
    input.code === 'NumpadAdd'
  ) return 'zoom-editor-in'
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0')
    return 'zoom-editor-reset'

  return null
}

/**
 * Electron/Chromium 的页面缩放发生在 renderer keydown 之前，因此必须在 webContents
 * 输入边界先 preventDefault；随后只给当前窗口的 renderer 发送编辑器字号命令。
 */
export function installWorkbenchEditorZoom(window: BrowserWindow): void {
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomFactor(1)
  })

  window.webContents.on('before-input-event', (event, input) => {
    const command = getWorkbenchEditorZoomMenuCommand(input)
    if (!command) return

    event.preventDefault()
    window.webContents.setZoomFactor(1)
    window.webContents.send(WorkbenchProjectHubChannels.menuCommand, command)
  })
}
