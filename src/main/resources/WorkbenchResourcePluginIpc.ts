import { BrowserWindow, ipcMain } from 'electron'

import { isWorkbenchAgentEngineId } from '../../plugins/agent-engines/identity'
import {
  WorkbenchResourcePluginChannels,
  type WorkbenchResourcePluginId,
} from '../../shared/workbenchResourcePlugins'

import type { WorkbenchResourcePluginService } from './WorkbenchResourcePluginService'

export function registerWorkbenchResourcePluginIpc(
  service: WorkbenchResourcePluginService
): () => void {
  const broadcast = (): void => {
    const catalog = service.listCatalog()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(WorkbenchResourcePluginChannels.changed, catalog)
      }
    }
  }
  const unsubscribe = service.subscribe(broadcast)

  ipcMain.handle(WorkbenchResourcePluginChannels.list, () => service.listCatalog())
  ipcMain.handle(
    WorkbenchResourcePluginChannels.install,
    async (_event, request: unknown) => {
      await service.install(readPluginId(request))
      return service.listCatalog()
    }
  )
  ipcMain.handle(
    WorkbenchResourcePluginChannels.listAgentEngineModels,
    (_event, value: unknown) => {
      if (!isWorkbenchAgentEngineId(value)) {
        throw new TypeError('Unknown Workbench Agent engine id.')
      }
      return service.listAgentEngineModels(value)
    }
  )
  ipcMain.handle(
    WorkbenchResourcePluginChannels.setEnabled,
    async (_event, request: unknown) => {
      const parsed = readSetEnabledRequest(request)
      await service.setEnabled(parsed.id, parsed.enabled)
      return service.listCatalog()
    }
  )
  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchResourcePluginChannels.list)
    ipcMain.removeHandler(WorkbenchResourcePluginChannels.install)
    ipcMain.removeHandler(WorkbenchResourcePluginChannels.setEnabled)
    ipcMain.removeHandler(WorkbenchResourcePluginChannels.listAgentEngineModels)
  }
}

function readPluginId(request: unknown): WorkbenchResourcePluginId {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Resource plugin request must be an object.')
  }
  const id = (request as Record<string, unknown>)['id']
  if (id !== 'codegraph' && id !== 'claude-agent' && id !== 'chatgpt') {
    throw new Error('Unsupported Workbench resource plugin.')
  }
  return id
}

function readSetEnabledRequest(
  request: unknown
): { id: WorkbenchResourcePluginId; enabled: boolean } {
  const id = readPluginId(request)
  const enabled = (request as Record<string, unknown>)['enabled']
  if (typeof enabled !== 'boolean') {
    throw new Error('Resource plugin enabled state must be boolean.')
  }
  return { id, enabled }
}
