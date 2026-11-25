import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface HorizontalWheelScrollInput {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  deltaX: number
  deltaY: number
  deltaMode: number
}

interface ActiveTabRevealInput {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  tabStart: number
  tabWidth: number
  previousClientWidth?: number | undefined
}

/**
 * 将触控板/滚轮输入稳定地映射为标签栏水平位置。
 *
 * 触控板横向滑动时常混入少量反向 deltaY；只采用绝对值更大的轴，避免滚到边缘时
 * 两个轴互相拉扯。结果始终夹在真实滚动边界内，因此末端不会回弹或反向抖动。
 */
export function resolveEditorTabWheelScroll({
  scrollLeft,
  scrollWidth,
  clientWidth,
  deltaX,
  deltaY,
  deltaMode,
}: HorizontalWheelScrollInput): Nullable<number> {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  if (maxScrollLeft === 0) return null

  const dominantDelta = Math.abs(deltaX) >= Math.abs(deltaY) && deltaX !== 0 ? deltaX : deltaY
  if (!Number.isFinite(dominantDelta) || dominantDelta === 0) return null

  const deltaMultiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, clientWidth) : 1
  return Math.min(maxScrollLeft, Math.max(0, scrollLeft + dominantDelta * deltaMultiplier))
}

/** 仅在当前标签离开可视区时移动标签栏，已经可见时保持用户的滚动位置。 */
export function resolveActiveEditorTabScroll({
  scrollLeft,
  scrollWidth,
  clientWidth,
  tabStart,
  tabWidth,
  previousClientWidth,
}: ActiveTabRevealInput): Nullable<number> {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  if (maxScrollLeft === 0) return null

  const tabEnd = tabStart + tabWidth
  if (
    previousClientWidth !== undefined &&
    (tabStart < scrollLeft - 1 || tabEnd > scrollLeft + previousClientWidth + 1)
  )
    return null
  const viewportEnd = scrollLeft + clientWidth
  const nextScrollLeft = tabStart < scrollLeft
    ? tabStart
    : tabEnd > viewportEnd
      ? tabEnd - clientWidth
      : scrollLeft
  const clampedScrollLeft = Math.min(maxScrollLeft, Math.max(0, nextScrollLeft))
  return clampedScrollLeft === scrollLeft ? null : clampedScrollLeft
}

function readActiveEditorTabScroll(
  scroller: HTMLDivElement,
  previousClientWidth?: number
): Nullable<number> {
  const activeTab = scroller.querySelector<HTMLElement>(':scope > [data-active="true"]')
  if (!activeTab) return null
  const scrollerRect = scroller.getBoundingClientRect()
  const activeTabRect = activeTab.getBoundingClientRect()
  return resolveActiveEditorTabScroll({
    scrollLeft: scroller.scrollLeft,
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    tabStart: scroller.scrollLeft + activeTabRect.left - scrollerRect.left,
    tabWidth: activeTabRect.width,
    previousClientWidth,
  })
}

/** 编辑器标签溢出状态由 Workbench 产品控制，宿主只提供真实 DOM 容器。 */
export interface WorkbenchEditorTabOverflowController {
  tabScrollerOverflow: boolean
  tabScrollerRef: RefObject<HTMLDivElement | null>
}

export function useWorkbenchEditorTabOverflow(
  overflowKey: string,
  activeTabKey: Nullable<string>,
  overflowButtonRef: RefObject<HTMLButtonElement | null>
): WorkbenchEditorTabOverflowController {
  const [tabScrollerOverflow, setTabScrollerOverflow] = useState(false)
  const tabScrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = tabScrollerRef.current
    if (!scroller) return
    let previousClientWidth = scroller.clientWidth

    const syncOverflow = (): void => {
      const { clientWidth, scrollWidth } = scroller
      const overflowButton = overflowButtonRef.current
      const actions = overflowButton?.parentElement
      const buttonGap =
        actions && actions.childElementCount > 1
          ? Number.parseFloat(getComputedStyle(actions).columnGap) || 0
          : 0
      // 先算出隐藏溢出菜单后能用的宽度，避免菜单自己占位导致它一直显示。
      const availableWidth = clientWidth + (overflowButton?.offsetWidth ?? 0) + buttonGap
      setTabScrollerOverflow(scrollWidth > availableWidth + 1)

      if (clientWidth < previousClientWidth) {
        const nextScrollLeft = readActiveEditorTabScroll(scroller, previousClientWidth)
        if (nextScrollLeft !== null) scroller.scrollLeft = nextScrollLeft
      }
      previousClientWidth = clientWidth
    }

    syncOverflow()
    const observer = new ResizeObserver(syncOverflow)
    observer.observe(scroller)
    const tabBar = scroller.parentElement
    if (tabBar) observer.observe(tabBar)

    const handleWheel = (event: WheelEvent): void => {
      const nextScrollLeft = resolveEditorTabWheelScroll({
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      })
      if (nextScrollLeft === null) return

      event.preventDefault()
      if (nextScrollLeft !== scroller.scrollLeft) scroller.scrollLeft = nextScrollLeft
    }

    scroller.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      observer.disconnect()
      scroller.removeEventListener('wheel', handleWheel)
    }
  }, [overflowButtonRef, overflowKey])

  useLayoutEffect(() => {
    if (!activeTabKey) return
    const scroller = tabScrollerRef.current
    if (!scroller) return
    const nextScrollLeft = readActiveEditorTabScroll(scroller)
    if (nextScrollLeft === null) return

    scroller.scrollTo({ left: nextScrollLeft, behavior: 'smooth' })
  }, [activeTabKey, overflowKey])

  return {
    tabScrollerOverflow,
    tabScrollerRef,
  }
}
