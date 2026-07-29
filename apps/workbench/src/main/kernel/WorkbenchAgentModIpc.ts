import { ipcMain } from 'electron'

import { WorkbenchAgentModsChannels } from '../../shared/workbenchAgentMods'

import type { WorkbenchAgentModRuntime } from './WorkbenchAgentModRuntime'

/**
 * Read-only IPC face for {@link WorkbenchAgentModRuntime}'s装载报告。
 *
 * `getOverview` 直接转发 `runtime.getOverview()`——该方法本身是同步读当前登记表状态，
 * 每次调用都拿到最新报告,不需要额外的推送/订阅机制。v1 只读:不提供 activate/deactivate
 * 通道(启停语义与 reloadRequired 是 Desktop 先例,Workbench 留欠账,见
 * `WorkbenchAgentModRuntime` 类头注释)。
 */
export function registerWorkbenchAgentModIpc(runtime: WorkbenchAgentModRuntime): () => void {
  ipcMain.handle(WorkbenchAgentModsChannels.getOverview, () => runtime.getOverview())

  return () => {
    ipcMain.removeHandler(WorkbenchAgentModsChannels.getOverview)
  }
}
