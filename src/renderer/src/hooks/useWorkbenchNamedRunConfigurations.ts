import { useCallback, useEffect, useState } from 'react'

import {
  readWorkbenchNamedRunConfigurations,
  RUN_CONFIGURATIONS_STORAGE_KEY,
  saveWorkbenchNamedRunConfigurations,
  WORKBENCH_RUN_CONFIGURATIONS_CHANGED_EVENT,
  type WorkbenchNamedRunConfiguration,
} from '../models/commands/workbenchNamedRunConfigurations'

export interface WorkbenchNamedRunConfigurationsController {
  configurations: WorkbenchNamedRunConfiguration[]
  /** 整份换掉当前项目的运行配置（「编辑运行配置」对话框点保存时）。 */
  saveConfigurations: (configurations: readonly WorkbenchNamedRunConfiguration[]) => void
}

/** 当前项目里用户建的运行配置：从应用存储读，存了就跟着变。 */
export function useWorkbenchNamedRunConfigurations(
  projectId: LooseOptional<string>
): WorkbenchNamedRunConfigurationsController {
  const [configurations, setConfigurations] = useState<WorkbenchNamedRunConfiguration[]>(() =>
    readWorkbenchNamedRunConfigurations(projectId)
  )

  useEffect(() => {
    const refresh = (): void => setConfigurations(readWorkbenchNamedRunConfigurations(projectId))
    refresh()

    // 别的窗口存的配置经 storage 事件过来：同一个项目不会同时开在两个窗口里，但存储是共用的。
    const handleStorageChanged = (event: StorageEvent): void => {
      if (event.key === RUN_CONFIGURATIONS_STORAGE_KEY) refresh()
    }
    window.addEventListener(WORKBENCH_RUN_CONFIGURATIONS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', handleStorageChanged)
    return () => {
      window.removeEventListener(WORKBENCH_RUN_CONFIGURATIONS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', handleStorageChanged)
    }
  }, [projectId])

  const saveConfigurations = useCallback(
    (next: readonly WorkbenchNamedRunConfiguration[]): void => {
      if (!projectId) return

      setConfigurations(saveWorkbenchNamedRunConfigurations(projectId, next))
    },
    [projectId]
  )

  return { configurations, saveConfigurations }
}
