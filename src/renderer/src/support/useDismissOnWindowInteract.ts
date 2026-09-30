/** 独立 Workbench 应用副本（desktop `@hooks/ui/useDismissOnWindowInteract` 同源）。 */
import { useEventListener, useLatest, useMemoizedFn } from './genericHooks'

export interface UseDismissOnWindowInteractOptions {
  enabled: boolean
  onDismiss: () => void
  /** @default true */
  mouseDown?: boolean
  /** 捕获阶段的窗口滚动监听；匹配现有工作台浮层关闭行为。默认开启。 */
  scroll?: boolean
  /** @default true */
  escapeKey?: boolean
  /** 为真时鼠标按下不会触发关闭；滚动和退出键行为不变。 */
  ignoreMouseDown?: (event: globalThis.MouseEvent) => boolean
}

/**
 * 在外部鼠标按下、窗口滚动或退出键时关闭浮动界面。
 * 集中维护工作台上下文菜单和工具栏菜单模式。
 */
export function useDismissOnWindowInteract({
  enabled,
  onDismiss,
  mouseDown = true,
  scroll = true,
  escapeKey = true,
  ignoreMouseDown,
}: UseDismissOnWindowInteractOptions): void {
  const invokeDismiss = useMemoizedFn(() => {
    onDismiss()
  })
  const ignoreMouseDownLatest = useLatest(ignoreMouseDown)

  const handleDismissMouseDown = useMemoizedFn((event: globalThis.MouseEvent): void => {
    if (ignoreMouseDownLatest.current?.(event)) return
    invokeDismiss()
  })

  const handleDismissEscapeKey = useMemoizedFn((event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // 这一下 Esc 是给这层浮层的：标成已经用掉，全局快捷键（Esc 关右侧面板）不再跟着动。
    event.preventDefault()
    invokeDismiss()
  })

  useEventListener('mousedown', handleDismissMouseDown, { enable: enabled && mouseDown })

  useEventListener('scroll', invokeDismiss, {
    capture: true,
    enable: enabled && scroll,
  })

  // 捕获阶段接：全局快捷键也挂在 window 上，而且挂得更早，冒泡阶段轮不到这里先说话。
  useEventListener('keydown', handleDismissEscapeKey, {
    capture: true,
    enable: enabled && escapeKey,
  })
}
