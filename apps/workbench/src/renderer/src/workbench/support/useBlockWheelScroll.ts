/** 独立 Workbench 应用副本（desktop `@hooks/ui/useBlockWheelScroll` 同源）。 */
import { type RefObject, useEffect } from 'react'

/**
 * 阻止在浮层（如右键菜单）上滚动滚轮时穿透到背后可滚动的容器。
 *
 * 工作台的浮层用捕获阶段的窗口 `scroll` 监听来关闭自己，一旦滚轮穿透到背后的
 * 编辑器/文件树并使其滚动，就会误触发关闭。React 的 `onWheel` 是 passive 的，
 * `preventDefault` 无效，所以这里挂原生非 passive 监听在浮层元素上拦掉滚动。
 */
export function useBlockWheelScroll(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined

    const node = ref.current
    if (!node) return undefined

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [ref, enabled])
}
