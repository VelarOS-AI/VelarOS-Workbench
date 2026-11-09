import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  buildWorkbenchLayoutStyleVariables,
  DEFAULT_WORKBENCH_LAYOUT_SIZES,
  readWorkbenchLayoutSizes,
  resizeWorkbenchLayoutSizes,
  saveWorkbenchLayoutSizes,
  type WorkbenchResizablePane,
} from '../models/layout/workbenchLayoutModel'
import {
  getWorkbenchViewportProfile,
  resolveWorkbenchLayoutSizesForViewport,
  WORKBENCH_DESKTOP_VIEWPORT,
  type WorkbenchViewportProfile,
} from '../models/layout/workbenchViewport'
import { useLatest } from '../support/genericHooks'

interface UseWorkbenchLayoutControllerOptions {
  commandPanelOpen?: boolean
  rightToolOpen?: boolean
}

export type WorkbenchPaneResizeStarter = (
  pane: WorkbenchResizablePane,
  event: ReactPointerEvent<Element>
) => void

export interface WorkbenchLayoutController {
  style: CSSProperties
  /** 挂到外壳元素上：拖分隔条时逐帧直接改它身上的布局变量。 */
  shellRef: (element: Nullable<HTMLElement>) => void
  viewportProfile: WorkbenchViewportProfile
  filePaneWidth: number
  beginResizePane: WorkbenchPaneResizeStarter
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
  const shellElementRef = useRef<Nullable<HTMLElement>>(null)
  const resizeGestureRef = useRef<Nullable<{ cancel: () => void }>>(null)
  const latest = useLatest({ layoutSizes, viewportSize, commandPanelOpen, rightToolOpen })

  useLayoutEffect(
    () => () => {
      resizeGestureRef.current?.cancel()
    },
    []
  )

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
        ...buildWorkbenchLayoutStyleVariables(effectiveSizes),
        '--workbench-min-height': `${WORKBENCH_DESKTOP_VIEWPORT.minHeight}px`,
        '--workbench-min-width': `${WORKBENCH_DESKTOP_VIEWPORT.minWidth}px`,
      }) as CSSProperties,
    [effectiveSizes]
  )

  useEffect(() => {
    saveWorkbenchLayoutSizes(layoutSizes)
  }, [layoutSizes])

  const shellRef = useCallback((element: Nullable<HTMLElement>): void => {
    shellElementRef.current = element
  }, [])

  /**
   * 拖分隔条：拖拽中每帧只直接改外壳上的布局变量，松手时才把最终尺寸写回 React 状态（并落盘）一次。
   *
   * 以前每个 pointermove 都 setState，布局状态又挂在页面总 model 上，于是文件树、编辑器、整段聊天记录
   * 每帧都跟着重渲染，拖起来一顿一顿的。现在拖拽过程完全不经过 React：浏览器只做样式和布局。
   */
  const beginResizePane = useCallback<WorkbenchPaneResizeStarter>(
    (pane, event) => {
      if (event.button !== 0) return
      event.preventDefault()
      resizeGestureRef.current?.cancel()

      const pointerId = event.pointerId
      const startX = event.clientX
      const startY = event.clientY
      const startSizes = latest.current.layoutSizes
      const shell = shellElementRef.current
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      let draftSizes = startSizes
      let pointerX = startX
      let pointerY = startY
      let frame = 0
      const gesture = { cancel: (): void => finishResize(false) }

      const applyDraft = (): void => {
        frame = 0
        if (resizeGestureRef.current !== gesture) return
        draftSizes = resizeWorkbenchLayoutSizes(startSizes, pane, {
          x: pointerX - startX,
          y: pointerY - startY,
        })
        if (!shell) return
        const { viewportSize: viewport, commandPanelOpen: commandOpen, rightToolOpen: rightOpen } =
          latest.current
        const effective = resolveWorkbenchLayoutSizesForViewport(viewport, draftSizes, {
          commandPanelOpen: commandOpen,
          rightToolOpen: rightOpen,
        })
        for (const [name, value] of Object.entries(buildWorkbenchLayoutStyleVariables(effective)))
          shell.style.setProperty(name, value)
      }

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId || resizeGestureRef.current !== gesture) return
        pointerX = moveEvent.clientX
        pointerY = moveEvent.clientY
        if (!frame) frame = window.requestAnimationFrame(applyDraft)
      }

      function finishResize(commit: boolean): void {
        if (resizeGestureRef.current !== gesture) return
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
        if (frame) window.cancelAnimationFrame(frame)
        frame = 0
        if (commit) applyDraft()
        resizeGestureRef.current = null
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        shell?.removeAttribute('data-pane-resizing')
        if (commit) setLayoutSizes(draftSizes)
      }

      const stopResize = (stopEvent: PointerEvent): void => {
        if (stopEvent.pointerId === pointerId) finishResize(true)
      }

      resizeGestureRef.current = gesture
      document.body.style.cursor = pane === 'command' ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
      // 拖拽期间的样式开关：调试浏览器等 webview 不吃指针（否则拖过去就断），分隔条保持高亮。
      shell?.setAttribute('data-pane-resizing', pane)
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [latest]
  )

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
    shellRef,
    viewportProfile,
    filePaneWidth: effectiveSizes.filePaneWidth,
    beginResizePane,
    resetPaneSize,
  }
}
