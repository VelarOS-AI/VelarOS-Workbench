import { useEffect } from 'react'

import {
  getWorkbenchDebugStatus,
  runWorkbenchDebugAction,
  type WorkbenchDebugAction,
} from '../models/debug/workbenchDebugBridge'
import {
  getWorkbenchKeyboardShortcut,
  type WorkbenchKeyboardShortcutAction,
  type WorkbenchKeyboardShortcutMap,
} from '../models/layout/workbenchKeyboardShortcuts'
import { useLatest } from '../support/genericHooks'

/** 键位表里调试的那几项各是哪个调试动作。 */
export const WorkbenchDebugShortcutActions: Partial<
  Record<WorkbenchKeyboardShortcutAction, WorkbenchDebugAction>
> = {
  'debug-continue': 'continue',
  'debug-step-over': 'step-over',
  'debug-step-into': 'step-into',
  'debug-step-out': 'step-out',
  'debug-stop': 'stop',
}

/**
 * 调试控制键的 keydown 处理（独立出来，不挂 DOM 也能测）。只在调试中、而且这个动作此刻做得了时才拿走按键
 * （继续与单步要程序停着）；别的时候不碰，按键照常：F8 在编辑器里是「下一个问题」，F11 归系统与菜单。
 */
export function createWorkbenchDebugShortcutKeydownHandler(
  readKeymap: () => WorkbenchKeyboardShortcutMap | undefined,
  platform?: string
): (event: KeyboardEvent) => void {
  return (event) => {
    if (getWorkbenchDebugStatus() === 'idle') return

    const shortcut = getWorkbenchKeyboardShortcut(event, readKeymap(), platform)
    const action = shortcut ? WorkbenchDebugShortcutActions[shortcut] : undefined
    if (!action || !runWorkbenchDebugAction(action)) return

    event.preventDefault()
    event.stopPropagation()
  }
}

/**
 * 调试的控制键：继续、单步跳过 / 进入 / 跳出、结束。挂在捕获阶段——程序停着时这些键先归调试器，轮不到
 * 焦点所在的编辑器或终端。
 */
export function useWorkbenchDebugShortcuts({
  enabled,
  keymap,
}: {
  enabled: boolean
  keymap?: WorkbenchKeyboardShortcutMap
}): void {
  const keymapLatest = useLatest(keymap)

  useEffect(() => {
    if (!enabled) return

    const handleKeydown = createWorkbenchDebugShortcutKeydownHandler(() => keymapLatest.current)
    window.addEventListener('keydown', handleKeydown, true)
    return () => window.removeEventListener('keydown', handleKeydown, true)
  }, [enabled])
}
