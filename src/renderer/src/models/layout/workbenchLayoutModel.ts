import { Log } from '@velaros-ai/core'
import { readNumberScalar as readNumber } from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

import {
  clampWorkbenchPaneSize,
  type WorkbenchLayoutSizeSnapshot,
  type WorkbenchResizablePane,
} from './workbenchViewport'

export type { WorkbenchResizablePane } from './workbenchViewport'
export { clampWorkbenchPaneSize } from './workbenchViewport'

export interface WorkbenchLayoutSizes {
  commandPanelHeight: number
  filePaneWidth: number
  rightPaneWidth: number
}

export const DEFAULT_WORKBENCH_LAYOUT_SIZES: WorkbenchLayoutSizes = {
  commandPanelHeight: 210,
  filePaneWidth: 260,
  rightPaneWidth: 420,
}

const STORAGE_KEY = 'velaros.workbench.layout.v1'
const LEGACY_DEFAULT_RIGHT_PANE_WIDTH = 308
const log = Log.tag('workbench-layout-model')

export function normalizeWorkbenchLayoutSizes(
  sizes: Partial<WorkbenchLayoutSizes> | undefined
): WorkbenchLayoutSizes {
  const savedRightPaneWidth = readNumber(sizes?.rightPaneWidth)
  const rightPaneWidth =
    savedRightPaneWidth === LEGACY_DEFAULT_RIGHT_PANE_WIDTH
      ? DEFAULT_WORKBENCH_LAYOUT_SIZES.rightPaneWidth
      : (savedRightPaneWidth ?? DEFAULT_WORKBENCH_LAYOUT_SIZES.rightPaneWidth)

  return {
    commandPanelHeight: clampWorkbenchPaneSize(
      'command',
      readNumber(sizes?.commandPanelHeight) ?? DEFAULT_WORKBENCH_LAYOUT_SIZES.commandPanelHeight
    ),
    filePaneWidth: clampWorkbenchPaneSize(
      'file',
      readNumber(sizes?.filePaneWidth) ?? DEFAULT_WORKBENCH_LAYOUT_SIZES.filePaneWidth
    ),
    rightPaneWidth: clampWorkbenchPaneSize('right', rightPaneWidth),
  }
}

const workbenchLayoutSizesStore = createLocalStorageJsonStore<WorkbenchLayoutSizes>({
  key: STORAGE_KEY,
  fallback: DEFAULT_WORKBENCH_LAYOUT_SIZES,
  normalize: (value) => normalizeWorkbenchLayoutSizes(value as Partial<WorkbenchLayoutSizes>),
  log,
  readErrorMessage: '读取 workbench 布局尺寸失败，使用默认尺寸',
  writeErrorMessage: '写入 workbench 布局尺寸失败',
})

/** 拖分隔条时的尺寸：相对按下那一刻的尺寸加上拖拽位移，夹在各自的上下限内。 */
export function resizeWorkbenchLayoutSizes(
  startSizes: WorkbenchLayoutSizes,
  pane: WorkbenchResizablePane,
  delta: { x: number; y: number }
): WorkbenchLayoutSizes {
  switch (pane) {
    case 'file':
      return {
        ...startSizes,
        filePaneWidth: clampWorkbenchPaneSize('file', startSizes.filePaneWidth + delta.x),
      }
    case 'right':
      return {
        ...startSizes,
        rightPaneWidth: clampWorkbenchPaneSize('right', startSizes.rightPaneWidth - delta.x),
      }
    default:
      return {
        ...startSizes,
        commandPanelHeight: clampWorkbenchPaneSize(
          'command',
          startSizes.commandPanelHeight - delta.y
        ),
      }
  }
}

/** 外壳上的三条布局变量：React 渲染的内联样式与拖拽中的逐帧直写共用这一份，两边不会写出不同的值。 */
export function buildWorkbenchLayoutStyleVariables(
  sizes: WorkbenchLayoutSizeSnapshot
): Record<string, string> {
  return {
    '--workbench-command-panel-height': `${sizes.commandPanelHeight}px`,
    '--workbench-file-pane-width': `${sizes.filePaneWidth}px`,
    '--workbench-right-pane-width': `${sizes.rightPaneWidth}px`,
  }
}

export function readWorkbenchLayoutSizes(storage?: StorageLike): WorkbenchLayoutSizes {
  return workbenchLayoutSizesStore.read(storage)
}

export function saveWorkbenchLayoutSizes(sizes: WorkbenchLayoutSizes, storage?: StorageLike): void {
  workbenchLayoutSizesStore.write(normalizeWorkbenchLayoutSizes(sizes), storage)
}
