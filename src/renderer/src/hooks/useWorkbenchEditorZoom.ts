import { useEffect } from 'react'

import {
  getZoomedWorkbenchEditorZoomLevel,
  readWorkbenchPreferences,
  type WorkbenchEditorZoomAction,
} from '../models/workbenchPreferences'
import { useMemoizedFn } from '../support/genericHooks'

import type { WorkbenchPreferencesController } from './useWorkbenchPreferences'

export function useWorkbenchEditorZoom({
  updatePreferences,
}: Pick<WorkbenchPreferencesController, 'updatePreferences'>): (
  action: WorkbenchEditorZoomAction
) => void {
  const zoomEditor = useMemoizedFn((action: WorkbenchEditorZoomAction): void => {
    const current = readWorkbenchPreferences().editorZoomLevel
    const next = getZoomedWorkbenchEditorZoomLevel(current, action)
    if (next !== current) updatePreferences({ editorZoomLevel: next })
  })

  useEffect(() => {
    const handleWheel = (event: WheelEvent): void => {
      if (
        event.defaultPrevented ||
        !event.ctrlKey ||
        event.altKey ||
        !event.deltaY ||
        !(event.target instanceof Element) ||
        !event.target.closest('.cm-editor')
      )
        return
      event.preventDefault()
      zoomEditor(event.deltaY < 0 ? 'increase' : 'decrease')
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    const unsubscribe = window.velarosWorkbenchProjectHub?.onMenuCommand((command) => {
      if (command === 'zoom-editor-in') zoomEditor('increase')
      if (command === 'zoom-editor-out') zoomEditor('decrease')
      if (command === 'zoom-editor-reset') zoomEditor('reset')
    })
    return () => {
      unsubscribe?.()
      window.removeEventListener('wheel', handleWheel)
    }
  }, [zoomEditor])

  return zoomEditor
}
