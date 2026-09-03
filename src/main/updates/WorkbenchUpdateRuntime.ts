import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'

import {
  isWorkbenchUpdateChannel,
  WorkbenchUpdateChannels,
} from '../../shared/workbenchUpdate'
import { resolveVelarOSOfficialWebsiteMarket } from '../VelarOSOfficialWebsite'

import {
  WorkbenchCloudEndpointResolver,
  WorkbenchCloudRoutingManifestFileStore,
  workbenchCloudRoutingManifestUrls,
  WorkbenchCloudRoutingMinimumRevision,
  WorkbenchCloudRoutingPublicKeySpki,
  WorkbenchEmbeddedCloudBaseUrl,
} from './WorkbenchCloudEndpointResolver'
import { CloudWorkbenchReleaseSource } from './WorkbenchReleaseSource'
import { WorkbenchUpdatePreferencesStore } from './WorkbenchUpdatePreferencesStore'
import { WorkbenchUpdateService } from './WorkbenchUpdateService'

const { autoUpdater } = electronUpdater

export function installWorkbenchUpdateRuntime(): void {
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
  const service = new WorkbenchUpdateService(
    new CloudWorkbenchReleaseSource(endpointResolver),
    autoUpdater,
    new WorkbenchUpdatePreferencesStore(app.getPath('userData')),
    {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
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
    for (const channel of Object.values(WorkbenchUpdateChannels)) {
      if (channel !== WorkbenchUpdateChannels.changed) ipcMain.removeHandler(channel)
    }
  })
  service.start()
}
