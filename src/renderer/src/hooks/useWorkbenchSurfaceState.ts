import { useState } from 'react'

import { isPresent } from '@velaros-ai/core'

import type {
  WorkbenchBottomTool,
  WorkbenchLeftTool,
  WorkbenchRightToolWindow,
} from '../models/layout/workbenchSurfaceModel'

export type {
  WorkbenchBottomTool,
  WorkbenchLeftTool,
  WorkbenchRightToolWindow,
} from '../models/layout/workbenchSurfaceModel'

/**
 * 最近一次要求打开快速打开：`files` 是 ⌘P（按文件名找），`commands` 是 ⇧⌘P（命令面板）。
 * 每次要求序号都加一，开着时再按一次也看得出来。
 */
export interface WorkbenchQuickOpenRequest {
  id: number
  mode: 'files' | 'commands'
}

export interface WorkbenchSurfaceState {
  activeBottomTool: WorkbenchBottomTool
  activeLeftTool: WorkbenchLeftTool
  activeRightTool: Nullable<WorkbenchRightToolWindow>
  isCommandPanelCollapsed: boolean
  isFilePanelOpen: boolean
  isQuickOpenOpen: boolean
  quickOpenRequest: WorkbenchQuickOpenRequest
  isRightToolOpen: boolean
  collapseCommandPanel: () => void
  closeQuickOpen: () => void
  closeRightTool: () => void
  openBottomTool: (tool: WorkbenchBottomTool) => void
  openQuickOpen: () => void
  openCommandPalette: () => void
  openRightTool: (tool: WorkbenchRightToolWindow) => void
  setActiveLeftTool: (tool: WorkbenchLeftTool) => void
  setActiveBottomTool: (tool: WorkbenchBottomTool) => void
  toggleCommandPanelCollapsed: () => void
  toggleFilePanel: () => void
  toggleRightTool: (tool: WorkbenchRightToolWindow) => void
}

export function useWorkbenchSurfaceState(): WorkbenchSurfaceState {
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false)
  const [quickOpenRequest, setQuickOpenRequest] = useState<WorkbenchQuickOpenRequest>({
    id: 0,
    mode: 'files',
  })
  const [activeLeftTool, setActiveLeftTool] = useState<WorkbenchLeftTool>('project')
  const [activeRightTool, setActiveRightTool] =
    useState<Nullable<WorkbenchRightToolWindow>>(null)
  const [activeBottomTool, setActiveBottomToolState] = useState<WorkbenchBottomTool>('run')
  const [isCommandPanelCollapsed, setIsCommandPanelCollapsed] = useState(true)
  const [isFilePanelOpen, setIsFilePanelOpen] = useState(true)

  function requestQuickOpen(mode: WorkbenchQuickOpenRequest['mode']): void {
    setQuickOpenRequest((request) => ({ id: request.id + 1, mode }))
    setIsQuickOpenOpen(true)
  }

  function openQuickOpen(): void {
    requestQuickOpen('files')
  }

  function openCommandPalette(): void {
    requestQuickOpen('commands')
  }

  function closeQuickOpen(): void {
    setIsQuickOpenOpen(false)
  }

  function closeRightTool(): void {
    setActiveRightTool(null)
  }

  function openRightTool(tool: WorkbenchRightToolWindow): void {
    setActiveRightTool(tool)
  }

  function toggleRightTool(tool: WorkbenchRightToolWindow): void {
    setActiveRightTool((currentTool) => (currentTool === tool ? null : tool))
  }

  function openBottomTool(tool: WorkbenchBottomTool): void {
    setActiveBottomToolState(tool)
    setIsCommandPanelCollapsed(false)
  }

  function setActiveBottomTool(tool: WorkbenchBottomTool): void {
    setActiveBottomToolState(tool)
    setIsCommandPanelCollapsed(false)
  }

  function toggleCommandPanelCollapsed(): void {
    setIsCommandPanelCollapsed((collapsed) => !collapsed)
  }

  function toggleFilePanel(): void {
    setIsFilePanelOpen((open) => !open)
  }

  function collapseCommandPanel(): void {
    setIsCommandPanelCollapsed(true)
  }

  return {
    activeBottomTool,
    activeLeftTool,
    activeRightTool,
    isCommandPanelCollapsed,
    isFilePanelOpen,
    isQuickOpenOpen,
    quickOpenRequest,
    isRightToolOpen: isPresent(activeRightTool),
    collapseCommandPanel,
    closeQuickOpen,
    closeRightTool,
    openBottomTool,
    openQuickOpen,
    openCommandPalette,
    openRightTool,
    setActiveLeftTool,
    setActiveBottomTool,
    toggleCommandPanelCollapsed,
    toggleFilePanel,
    toggleRightTool,
  }
}
