import { BrowserWindow, ipcMain } from 'electron'

import { isWorkbenchAgentEngineId } from '../../plugins/agent-engines/identity'
import {
  WorkbenchAgentModChannels,
  type WorkbenchModRecord,
} from '../../shared/workbenchAgentMods'

import type { WorkbenchModService } from './WorkbenchModService'

export function registerWorkbenchModIpc(service: WorkbenchModService): () => void {
  const broadcast = (): void => {
    const catalog = service.listCatalog()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WorkbenchAgentModChannels.changed, catalog)
    }
  }
  const unsubscribe = service.subscribe(broadcast)

  ipcMain.handle(WorkbenchAgentModChannels.list, () => service.listCatalog())
  ipcMain.handle(WorkbenchAgentModChannels.setEnabled, async (_event, request: unknown) => {
    const parsed = readSetEnabledRequest(request)
    await service.setEnabled(parsed.id, parsed.enabled)
    return service.listCatalog()
  })
  ipcMain.handle(WorkbenchAgentModChannels.listAgentEngineModels, (_event, value: unknown) => {
    if (!isWorkbenchAgentEngineId(value)) throw new TypeError('Unknown Workbench Agent engine id.')
    return service.listAgentEngineModels(value)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchAgentModChannels.list)
    ipcMain.removeHandler(WorkbenchAgentModChannels.setEnabled)
    ipcMain.removeHandler(WorkbenchAgentModChannels.listAgentEngineModels)
  }
}

function readSetEnabledRequest(
  request: unknown
): { id: WorkbenchModRecord['id']; enabled: boolean } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Workbench Mod request must be an object.')
  }
  const record = request as Record<string, unknown>
  if (record['id'] !== 'velaros.agent-engines' || typeof record['enabled'] !== 'boolean') {
    throw new Error('Workbench Mod enabled request is invalid.')
  }
  return { id: record['id'], enabled: record['enabled'] }
}
