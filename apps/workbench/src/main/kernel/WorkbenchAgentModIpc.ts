import { ipcMain } from 'electron'

import { WorkbenchAgentModsChannels } from '../../shared/workbenchAgentMods'

import type { WorkbenchModService } from './WorkbenchModService'

/**
 * mod 门面的 IPC 面（设置页「模组」视图数据源）。
 *
 * P6 起数据源是**本地单 owner** 的 {@link WorkbenchModService}：本地 pack 清单 ×
 * Agent 轴装载报告，不再经 Kernel daemon 的 `mods.*` RPC。`getOverview` 每次现读，
 * 因此不需要额外的推送/订阅机制。
 *
 * v1 仍只读：启停（`setEnabled`）与原地安装（`installFromDirectory`）在 service 层已
 * 就位，但还没开 IPC 通道与设置页控件——留欠账，见 docs/agent-mod-trunk.md。
 */
export function registerWorkbenchAgentModIpc(service: WorkbenchModService): () => void {
  ipcMain.handle(WorkbenchAgentModsChannels.getOverview, () => service.getSettingsOverview())

  return () => {
    ipcMain.removeHandler(WorkbenchAgentModsChannels.getOverview)
  }
}
