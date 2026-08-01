/** Standalone Workbench 桌面窗口尺寸策略（main / renderer 共用）。 */
const WORKBENCH_DESKTOP_VIEWPORT = {
  minWidth: 1040,
  minHeight: 680,
  defaultWidth: 1040,
  defaultHeight: 720,
  /** 侧栏 + 编辑区开始明显收紧。 */
  breakpointNarrow: 1180,
  /** 顶栏与侧栏进入紧凑模式。 */
  breakpointCompact: 1320,
  /** 宽屏：侧栏可恢复到用户保存的更大默认值。 */
  breakpointWide: 1600,
  rightToolRailWidth: 36,
  minEditorWidth: 360,
  /** 保留给编辑器 + 顶栏/状态栏的最小主内容高度。 */
  minMainContentHeight: 280,
} as const

type WorkbenchViewportProfile = 'compact' | 'narrow' | 'standard' | 'wide'

type WorkbenchResizablePane = 'command' | 'file' | 'right'

interface WorkbenchLayoutSizeSnapshot {
  commandPanelHeight: number
  filePaneWidth: number
  rightPaneWidth: number
}

const WORKBENCH_PANE_SIZE_LIMITS: Record<
  WorkbenchResizablePane,
  { max: number; min: number }
> = {
  command: { min: 96, max: 560 },
  file: { min: 200, max: 380 },
  right: { min: 360, max: 720 },
}

function clampWorkbenchPaneSize(pane: WorkbenchResizablePane, size: number): number {
  const limits = WORKBENCH_PANE_SIZE_LIMITS[pane]
  return Math.min(limits.max, Math.max(limits.min, Math.round(size)))
}

function getWorkbenchViewportProfile(width: number): WorkbenchViewportProfile {
  if (width >= WORKBENCH_DESKTOP_VIEWPORT.breakpointWide) return 'wide'
  if (width >= WORKBENCH_DESKTOP_VIEWPORT.breakpointCompact) return 'standard'
  if (width >= WORKBENCH_DESKTOP_VIEWPORT.breakpointNarrow) return 'compact'
  return 'narrow'
}

function resolveWorkbenchLayoutSizesForViewport(
  viewport: { width: number; height: number },
  sizes: WorkbenchLayoutSizeSnapshot,
  options: { commandPanelOpen: boolean; rightToolOpen: boolean }
): WorkbenchLayoutSizeSnapshot {
  const maxFilePaneWidth =
    viewport.width -
    WORKBENCH_DESKTOP_VIEWPORT.rightToolRailWidth -
    (options.rightToolOpen ? sizes.rightPaneWidth : 0) -
    WORKBENCH_DESKTOP_VIEWPORT.minEditorWidth

  const filePaneWidth = clampWorkbenchPaneSize(
    'file',
    Math.min(sizes.filePaneWidth, maxFilePaneWidth)
  )

  let rightPaneWidth = sizes.rightPaneWidth
  if (options.rightToolOpen) {
    const maxRightPaneWidth =
      viewport.width -
      WORKBENCH_DESKTOP_VIEWPORT.rightToolRailWidth -
      filePaneWidth -
      WORKBENCH_DESKTOP_VIEWPORT.minEditorWidth
    rightPaneWidth = clampWorkbenchPaneSize(
      'right',
      Math.min(sizes.rightPaneWidth, maxRightPaneWidth)
    )
  }

  const commandPanelHeight = options.commandPanelOpen
    ? clampWorkbenchPaneSize(
        'command',
        Math.min(
          sizes.commandPanelHeight,
          viewport.height - WORKBENCH_DESKTOP_VIEWPORT.minMainContentHeight
        )
      )
    : sizes.commandPanelHeight

  return {
    commandPanelHeight,
    filePaneWidth,
    rightPaneWidth,
  }
}

export {
  clampWorkbenchPaneSize,
  getWorkbenchViewportProfile,
  resolveWorkbenchLayoutSizesForViewport,
  WORKBENCH_DESKTOP_VIEWPORT,
  WORKBENCH_PANE_SIZE_LIMITS,
}
export type {
  WorkbenchLayoutSizeSnapshot,
  WorkbenchResizablePane,
  WorkbenchViewportProfile,
}
