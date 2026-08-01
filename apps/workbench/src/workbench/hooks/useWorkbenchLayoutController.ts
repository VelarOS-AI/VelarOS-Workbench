import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'

import { type PointerResizeStarter, usePointerResize } from '@velaros-ai/ui/hooks/usePointerResize'

import {
  DEFAULT_WORKBENCH_LAYOUT_SIZES,
  readWorkbenchLayoutSizes,
  saveWorkbenchLayoutSizes,
  type WorkbenchLayoutSizes,
  type WorkbenchResizablePane,
} from '../models/layout/workbenchLayoutModel'
import {
  clampWorkbenchPaneSize,
  getWorkbenchViewportProfile,
  resolveWorkbenchLayoutSizesForViewport,
  WORKBENCH_DESKTOP_VIEWPORT,
  type WorkbenchViewportProfile,
} from '../models/layout/workbenchViewport'

interface UseWorkbenchLayoutControllerOptions {
  commandPanelOpen?: boolean
  rightToolOpen?: boolean
}

export interface WorkbenchLayoutController {
  style: CSSProperties
  viewportProfile: WorkbenchViewportProfile
  filePaneWidth: number
  beginResizePane: PointerResizeStarter<WorkbenchResizablePane>
  resetPaneSize: (pane: WorkbenchResizablePane) => void
}

export function useWorkbenchLayoutController(
  options: UseWorkbenchLayoutControllerOptions = {}
): WorkbenchLayoutController {
  const commandPanelOpen = options.commandPanelOpen ?? false
  const rightToolOpen = options.rightToolOpen ?? false
  const [layoutSizes, setLayoutSizes] = useState(() => readWorkbenchLayoutSizes())
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    function handleResize(): void {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const viewportProfile = useMemo(
    () => getWorkbenchViewportProfile(viewportSize.width),
    [viewportSize.width]
  )

  const effectiveSizes = useMemo(
    () =>
      resolveWorkbenchLayoutSizesForViewport(viewportSize, layoutSizes, {
        commandPanelOpen,
        rightToolOpen,
      }),
    [commandPanelOpen, layoutSizes, rightToolOpen, viewportSize]
  )

  const style = useMemo(
    () =>
      ({
        '--workbench-command-panel-height': `${effectiveSizes.commandPanelHeight}px`,
        '--workbench-file-pane-width': `${effectiveSizes.filePaneWidth}px`,
        '--workbench-min-height': `${WORKBENCH_DESKTOP_VIEWPORT.minHeight}px`,
        '--workbench-min-width': `${WORKBENCH_DESKTOP_VIEWPORT.minWidth}px`,
        '--workbench-right-pane-width': `${effectiveSizes.rightPaneWidth}px`,
      }) as CSSProperties,
    [effectiveSizes]
  )

  useEffect(() => {
    saveWorkbenchLayoutSizes(layoutSizes)
  }, [layoutSizes])

  const beginResizePane = usePointerResize<WorkbenchResizablePane, WorkbenchLayoutSizes>({
    cursor: (pane) => (pane === 'command' ? 'row-resize' : 'col-resize'),
    onResizeStart: () => layoutSizes,
    onResize: useCallback((pane, move, startSizes) => {
      setLayoutSizes((currentSizes) => {
        switch (pane) {
          case 'file': {
            return {
              ...currentSizes,
              filePaneWidth: clampWorkbenchPaneSize('file', startSizes.filePaneWidth + move.deltaX),
            }
          }
          case 'right': {
            return {
              ...currentSizes,
              rightPaneWidth: clampWorkbenchPaneSize(
                'right',
                startSizes.rightPaneWidth - move.deltaX
              ),
            }
          }
          default: {
            return {
              ...currentSizes,
              commandPanelHeight: clampWorkbenchPaneSize(
                'command',
                startSizes.commandPanelHeight - move.deltaY
              ),
            }
          }
        }
      })
    }, []),
  })

  function resetPaneSize(pane: WorkbenchResizablePane): void {
    setLayoutSizes((currentSizes) => {
      switch (pane) {
        case 'file': {
          return {
            ...currentSizes,
            filePaneWidth: DEFAULT_WORKBENCH_LAYOUT_SIZES.filePaneWidth,
          }
        }
        case 'right': {
          return {
            ...currentSizes,
            rightPaneWidth: DEFAULT_WORKBENCH_LAYOUT_SIZES.rightPaneWidth,
          }
        }
        default: {
          return {
            ...currentSizes,
            commandPanelHeight: DEFAULT_WORKBENCH_LAYOUT_SIZES.commandPanelHeight,
          }
        }
      }
    })
  }

  return {
    style,
    viewportProfile,
    filePaneWidth: effectiveSizes.filePaneWidth,
    beginResizePane,
    resetPaneSize,
  }
}
