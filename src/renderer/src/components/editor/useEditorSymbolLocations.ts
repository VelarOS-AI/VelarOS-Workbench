import { useCallback, useMemo, useState } from 'react'
import {
  navigateWorkbenchSymbolLocations,
  openWorkbenchSymbolLocations,
  sameWorkbenchSymbolLocation,
  type WorkbenchSymbolLocationsRequest,
  type WorkbenchSymbolLocationsState,
} from '@renderer/models/editor/workbenchSymbolLocations'

import type { WorkbenchLanguageServiceLocation } from '@shared/contracts'

export interface EditorSymbolLocations {
  /** 面板此刻列着什么；收起来时为 null。 */
  state: Nullable<WorkbenchSymbolLocationsState>
  /** 换一份列表；`visible` 省略时面板开着还是收着不变（跳到定义之后悄悄把引用补上）。 */
  open: (request: WorkbenchSymbolLocationsRequest, visible?: boolean) => void
  close: () => void
  /** 要跳到列表里的一处：记下从哪来（面板上的「返回」）。已经在那一处返回 false，不用跳。 */
  navigate: (location: WorkbenchLanguageServiceLocation) => boolean
}

/**
 * 定义 / 引用列表面板（EditorSymbolLocationsPanel）的状态。编辑区并排的两组共用一份：点列表里的一行，目标文件
 * 开在另一组里时面板跟过去——哪一组的编辑器正显示着「眼下那一处」所在的文件，面板就画在哪一组上。
 */
export function useEditorSymbolLocations(): EditorSymbolLocations {
  const [locations, setLocations] = useState<Nullable<WorkbenchSymbolLocationsState>>(null)
  const [visible, setVisible] = useState(false)

  const open = useCallback((request: WorkbenchSymbolLocationsRequest, nextVisible?: boolean) => {
    setLocations((current) => {
      const opened = openWorkbenchSymbolLocations(request)
      if (
        current?.returnLocation
        && sameWorkbenchSymbolLocation(current.activeLocation, opened.activeLocation)
      ) return { ...opened, returnLocation: current.returnLocation }
      return opened
    })
    if (nextVisible !== undefined) setVisible(nextVisible)
  }, [])
  const close = useCallback(() => setVisible(false), [])
  const navigate = useCallback(
    (location: WorkbenchLanguageServiceLocation): boolean => {
      if (locations && sameWorkbenchSymbolLocation(locations.activeLocation, location)) return false

      setLocations((current) =>
        current ? navigateWorkbenchSymbolLocations(current, location) : current
      )
      return true
    },
    [locations]
  )

  return useMemo(
    () => ({ state: visible ? locations : null, open, close, navigate }),
    [close, locations, navigate, open, visible]
  )
}
