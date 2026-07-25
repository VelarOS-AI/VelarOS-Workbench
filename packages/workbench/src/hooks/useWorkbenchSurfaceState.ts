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

export interface WorkbenchSurfaceState {
  activeBottomTool: WorkbenchBottomTool
  activeLeftTool: WorkbenchLeftTool
  activeRightTool: Nullable<WorkbenchRightToolWindow>
  isCommandPanelCollapsed: boolean
  isQuickOpenOpen: boolean
  isRightToolOpen: boolean
  collapseCommandPanel: () => void
  closeQuickOpen: () => void
  closeRightTool: () => void
  openBottomTool: (tool: WorkbenchBottomTool) => void
  openQuickOpen: () => void
  openRightTool: (tool: WorkbenchRightToolWindow) => void
  setActiveLeftTool: (tool: WorkbenchLeftTool) => void
  setActiveBottomTool: (tool: WorkbenchBottomTool) => void
  toggleCommandPanelCollapsed: () => void
  toggleRightTool: (tool: WorkbenchRightToolWindow) => void
}

export function useWorkbenchSurfaceState(): WorkbenchSurfaceState {
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false)
  const [activeLeftTool, setActiveLeftTool] = useState<WorkbenchLeftTool>('project')
  const [activeRightTool, setActiveRightTool] =
    useState<Nullable<WorkbenchRightToolWindow>>(null)
  const [activeBottomTool, setActiveBottomToolState] = useState<WorkbenchBottomTool>('run')
  const [isCommandPanelCollapsed, setIsCommandPanelCollapsed] = useState(true)

  function openQuickOpen(): void {
    setIsQuickOpenOpen(true)
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

  function collapseCommandPanel(): void {
    setIsCommandPanelCollapsed(true)
  }

  return {
    activeBottomTool,
    activeLeftTool,
    activeRightTool,
    isCommandPanelCollapsed,
    isQuickOpenOpen,
    isRightToolOpen: isPresent(activeRightTool),
    collapseCommandPanel,
    closeQuickOpen,
    closeRightTool,
    openBottomTool,
    openQuickOpen,
    openRightTool,
    setActiveLeftTool,
    setActiveBottomTool,
    toggleCommandPanelCollapsed,
    toggleRightTool,
  }
}
