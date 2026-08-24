import { useCallback, useEffect, useState } from 'react'

import type { WorkbenchCodeGraphResourceStatus } from '../../../shared/workbenchWorkspace'

/**
 * 独立 Workbench 的 CodeGraph 物理资源投影。
 *
 * 基础项目索引始终由 @velaros-ai/project 提供；这里只探测 VelarOS 组织级共享资源根中的
 * CodeGraph 增强包。窗口重新聚焦时再探测一次，Desktop 安装完成后无需重启 Workbench。
 */
export function useCodeGraphResourceAvailability(): boolean {
  const [available, setAvailable] = useState(false)

  const refresh = useCallback(() => {
    void window.velarosWorkbenchWorkspace.invoke({
      projectRoot: '',
      operation: 'resource:codegraph-status',
      input: {},
    }).then((result) => {
      if (!result.ok) {
        setAvailable(false)
        return
      }
      const status = result.output as WorkbenchCodeGraphResourceStatus
      setAvailable(status.available === true)
    }).catch(() => setAvailable(false))
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  return available
}
