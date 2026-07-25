import { Log } from '@velaros/core'
import {
  clampWorkbenchPaneSize,
} from '@velaros/core/constants/workbenchViewport'
import { readNumberScalar as readNumber } from '@velaros/core/utils/unknownJsonRecord'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

export type { WorkbenchResizablePane } from '@velaros/core/constants/workbenchViewport'
export { clampWorkbenchPaneSize } from '@velaros/core/constants/workbenchViewport'

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

export function readWorkbenchLayoutSizes(storage?: StorageLike): WorkbenchLayoutSizes {
  return workbenchLayoutSizesStore.read(storage)
}

export function saveWorkbenchLayoutSizes(sizes: WorkbenchLayoutSizes, storage?: StorageLike): void {
  workbenchLayoutSizesStore.write(normalizeWorkbenchLayoutSizes(sizes), storage)
}
