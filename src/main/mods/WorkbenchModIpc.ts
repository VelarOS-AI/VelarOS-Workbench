import { BrowserWindow, ipcMain } from 'electron'

import {
  WorkbenchModChannels,
  type WorkbenchModId,
  type WorkbenchModSetEnabledRequest,
} from '../../shared/workbenchMods'

import type { WorkbenchModService } from './WorkbenchModService'

/** Renderer 只能按稳定 Mod id 请求启停，清单与世代号仍由主进程生成。 */
export function registerWorkbenchModIpc(service: WorkbenchModService): () => void {
  const broadcast = (): void => {
    const event = { generation: service.listCatalog().generation }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WorkbenchModChannels.changed, event)
    }
  }
  const unsubscribe = service.subscribe(broadcast)

  ipcMain.handle(WorkbenchModChannels.listCatalog, () => service.listCatalog())
  ipcMain.handle(WorkbenchModChannels.setEnabled, (_event, request: unknown) => {
    const parsed = readSetEnabledRequest(request)
    return service.setEnabled(parsed.id, parsed.enabled)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchModChannels.listCatalog)
    ipcMain.removeHandler(WorkbenchModChannels.setEnabled)
  }
}

function readSetEnabledRequest(request: unknown): WorkbenchModSetEnabledRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Workbench Mod request must be an object.')
  }
  const record = request as Record<string, unknown>
  const id = readModId(record['id'])
  if (typeof record['enabled'] !== 'boolean') {
    throw new Error('Workbench Mod enabled state must be boolean.')
  }
  return { id, enabled: record['enabled'] }
}

function readModId(value: unknown): WorkbenchModId {
  if (value !== 'velaros.browser') throw new Error('Unsupported Workbench Mod.')
  return value
}
