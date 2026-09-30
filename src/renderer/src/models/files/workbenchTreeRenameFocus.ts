/** 改名框失去焦点之后这么久之内，树拿回焦点算是它在「还焦点」，不是用户自己点回来的。 */
export const WorkbenchTreeRenameFocusWindowMs = 300

type FocusReceiver = Pick<HTMLElement, 'focus' | 'isConnected'>

/** 树的根元素上用得到的那几样；`contains` 收的是失去焦点时焦点的去处。 */
interface FocusTrackingTree {
  contains: (target: never) => boolean
  addEventListener: (type: 'focusin', listener: () => void) => void
  removeEventListener: (type: 'focusin', listener: () => void) => void
}

function isFocusReceiver(target: unknown): target is FocusReceiver {
  return !!target && typeof (target as Partial<FocusReceiver>).focus === 'function'
}

/**
 * 项目树里改名改到一半，焦点被别处拿走（点进了编辑器、按 ⌘P 打开了快速打开）：改名取消之后，树会把焦点
 * 还给那一行（react-arborist 的 `reset` 里排了一次 `onFocus`），等于把焦点抢了回来——编辑器点了却没拿到
 * 焦点，之后敲的字都进了树的按字母找文件。
 *
 * 在取消改名之前调用：树在随后这一小段时间里拿回焦点的那一刻，把焦点交回给拿走它的那个元素（`next`，
 * 即 blur 事件的 `relatedTarget`）。焦点是在树里面挪的、或者没有去处（切到别的应用、点在不能聚焦的
 * 地方）时什么都不做：那时还给那一行正合适。
 */
export function keepFocusOutsideTreeAfterRename(
  tree: Nullable<FocusTrackingTree>,
  next: unknown
): void {
  if (!tree || !isFocusReceiver(next) || tree.contains(next as never)) return

  function handBack(): void {
    stop()
    if (isFocusReceiver(next) && next.isConnected) next.focus({ preventScroll: true })
  }
  const timer = setTimeout(stop, WorkbenchTreeRenameFocusWindowMs)
  function stop(): void {
    tree?.removeEventListener('focusin', handBack)
    clearTimeout(timer)
  }
  tree.addEventListener('focusin', handBack)
}
