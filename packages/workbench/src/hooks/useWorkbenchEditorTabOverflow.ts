import { type RefObject, useEffect, useRef, useState } from 'react'

/** 编辑器标签溢出状态由 Workbench 产品控制，宿主只提供真实 DOM 容器。 */
export interface WorkbenchEditorTabOverflowController {
  tabScrollerOverflow: boolean
  tabScrollerRef: RefObject<HTMLDivElement | null>
}

export function useWorkbenchEditorTabOverflow(
  overflowKey: string
): WorkbenchEditorTabOverflowController {
  const [tabScrollerOverflow, setTabScrollerOverflow] = useState(false)
  const tabScrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scroller = tabScrollerRef.current
    if (!scroller) return

    const syncOverflow = (): void => {
      setTabScrollerOverflow(scroller.scrollWidth > scroller.clientWidth + 1)
    }

    syncOverflow()
    const observer = new ResizeObserver(syncOverflow)
    observer.observe(scroller)
    const tabBar = scroller.parentElement
    if (tabBar) observer.observe(tabBar)

    return () => observer.disconnect()
  }, [overflowKey])

  return {
    tabScrollerOverflow,
    tabScrollerRef,
  }
}
