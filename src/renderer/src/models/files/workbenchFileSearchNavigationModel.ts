/** 搜索框里按下的键对结果列表的作用：挪到第几项，或打开当前项。 */
export type WorkbenchFileSearchKeyboardAction =
  | { kind: 'open-active' }
  | { kind: 'set-active'; index: number }

export function getWorkbenchFileSearchKeyboardAction(
  key: string,
  activeIndex: number,
  itemCount: number
): Nullable<WorkbenchFileSearchKeyboardAction> {
  if (!itemCount) return null

  switch (key) {
    case 'ArrowDown': {
      return { kind: 'set-active', index: (activeIndex + 1) % itemCount }
    }
    case 'ArrowUp': {
      return { kind: 'set-active', index: (activeIndex + itemCount - 1) % itemCount }
    }
    case 'Home': {
      return { kind: 'set-active', index: 0 }
    }
    case 'End': {
      return { kind: 'set-active', index: itemCount - 1 }
    }
    case 'Enter': {
      return { kind: 'open-active' }
    }
    default: {
      return null
    }
  }
}
