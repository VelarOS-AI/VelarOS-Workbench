import { join } from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import { Log } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import { isWorkbenchUpdateChannel, WorkbenchUpdateChannels } from '../../shared/workbenchUpdate'
import { resolveWorkbenchNodeExecutable } from '../conversation/WorkbenchNodeRuntime'
import { resolveVelarOSOfficialWebsiteMarket } from '../VelarOSOfficialWebsite'

import { WindowsArchiveUpdater } from './WindowsArchiveUpdater'
import {
  WorkbenchCloudEndpointResolver,
  WorkbenchCloudRoutingManifestFileStore,
  workbenchCloudRoutingManifestUrls,
  WorkbenchCloudRoutingMinimumRevision,
  WorkbenchCloudRoutingPublicKeySpki,
  WorkbenchEmbeddedCloudBaseUrl,
} from './WorkbenchCloudEndpointResolver'
import { CloudWorkbenchReleaseSource } from './WorkbenchReleaseSource'
import { WorkbenchUpdateDownloadCache } from './WorkbenchUpdateDownloadCache'
import { WorkbenchUpdatePreferencesStore } from './WorkbenchUpdatePreferencesStore'
import { WorkbenchUpdateService } from './WorkbenchUpdateService'

export function installWorkbenchUpdateRuntime(): void {
  const preferences = Result.wrapSync(() =>
    new WorkbenchUpdatePreferencesStore(app.getPath('userData'))
  )
  const removeHandlers = (): void => {
    for (const channel of Object.values(WorkbenchUpdateChannels))
      if (channel !== WorkbenchUpdateChannels.changed) ipcMain.removeHandler(channel)
  }
  if (!preferences.ok) {
    Log.tag('WorkbenchUpdate').error('Update preferences are unavailable', {
      error: preferences.error,
    })
    for (const channel of Object.values(WorkbenchUpdateChannels))
      if (channel !== WorkbenchUpdateChannels.changed)
        ipcMain.handle(channel, () => Result.unwrap(preferences))
    app.once('will-quit', removeHandlers)
    return
  }
  const market = resolveVelarOSOfficialWebsiteMarket({
    configuredMarket: process.env.VELAROS_MARKET,
    locale: app.getLocale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  const endpointResolver = new WorkbenchCloudEndpointResolver({
    market,
    embeddedBaseUrl: WorkbenchEmbeddedCloudBaseUrl,
    overrideBaseUrl: process.env.VELAROS_CLOUD_URL,
    manifestUrls: workbenchCloudRoutingManifestUrls(market),
    routingPublicKeySpki: WorkbenchCloudRoutingPublicKeySpki,
    minimumRevision: WorkbenchCloudRoutingMinimumRevision,
    manifestStore: new WorkbenchCloudRoutingManifestFileStore(app.getPath('userData'), market),
  })
  const windowsUpdater = process.platform === 'win32' && app.isPackaged
    ? new WindowsArchiveUpdater({
        appId: 'com.velaros.workbench',
        executable: process.execPath,
        nodeExecutable: resolveWorkbenchNodeExecutable(),
        workerFile: join(process.resourcesPath, 'windows-update.cjs'),
        userDataDirectory: app.getPath('userData'),
      })
    : null
  const service = new WorkbenchUpdateService(
    new CloudWorkbenchReleaseSource(endpointResolver),
    windowsUpdater ?? (async () => (await import('electron-updater')).default.autoUpdater),
    preferences.data,
    {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      downloadCache: new WorkbenchUpdateDownloadCache(
        join(app.getPath('userData'), 'update-downloads')
      ),
    }
  )
  const broadcast = (): void => {
    const state = service.getState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WorkbenchUpdateChannels.changed, state)
    }
  }
  service.subscribe(broadcast)

  ipcMain.handle(WorkbenchUpdateChannels.getState, () => service.getState())
  ipcMain.handle(WorkbenchUpdateChannels.check, () => service.checkForUpdates())
  ipcMain.handle(WorkbenchUpdateChannels.download, () => service.downloadUpdate())
  ipcMain.handle(WorkbenchUpdateChannels.pause, () => service.pauseDownload())
  ipcMain.handle(WorkbenchUpdateChannels.resume, () => service.resumeDownload())
  ipcMain.handle(WorkbenchUpdateChannels.cancel, () => service.cancelDownload())
  ipcMain.handle(WorkbenchUpdateChannels.restart, () => service.restartToUpdate())
  ipcMain.handle(WorkbenchUpdateChannels.setAutomaticDownloads, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Automatic update setting must be boolean.')
    return service.setAutomaticDownloads(enabled)
  })
  ipcMain.handle(WorkbenchUpdateChannels.setChannel, (_event, channel: unknown) => {
    if (!isWorkbenchUpdateChannel(channel)) throw new Error('Update channel is invalid.')
    return service.setChannel(channel)
  })

  app.once('will-quit', () => {
    void service.dispose()
    removeHandlers()
  })
  if (windowsUpdater) {
    void windowsUpdater.recovery
      .then(() => {
        if (service.getState().phase !== 'error') service.start()
      })
      .catch((error) => {
        Log.tag('WorkbenchUpdate').caught('Windows update startup recovery failed', error)
      })
  } else service.start()
}
