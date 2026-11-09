import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  isWorkbenchUpdateChannel,
  type WorkbenchUpdateChannel,
} from '../../shared/workbenchUpdate'

interface WorkbenchUpdatePreferencesFileV2 {
  readonly version: 2
  readonly automaticDownloads: boolean
  readonly channel: WorkbenchUpdateChannel
}

export class WorkbenchUpdatePreferencesStore {
  readonly #filePath: string
  #automaticDownloads: boolean
  #channel: WorkbenchUpdateChannel

  public constructor(dataRootDir: string) {
    this.#filePath = join(dataRootDir, 'storage', 'update-preferences.json')
    const preferences = readPreferences(this.#filePath)
    this.#automaticDownloads = preferences.automaticDownloads
    this.#channel = preferences.channel
  }

  public get automaticDownloads(): boolean {
    return this.#automaticDownloads
  }

  public get channel(): WorkbenchUpdateChannel {
    return this.#channel
  }

  public setAutomaticDownloads(enabled: boolean): void {
    if (this.#automaticDownloads === enabled) return
    this.#write(enabled, this.#channel)
    this.#automaticDownloads = enabled
  }

  public setChannel(channel: WorkbenchUpdateChannel): void {
    if (this.#channel === channel) return
    this.#write(this.#automaticDownloads, channel)
    this.#channel = channel
  }

  #write(automaticDownloads: boolean, channel: WorkbenchUpdateChannel): void {
    const file: WorkbenchUpdatePreferencesFileV2 = {
      version: 2,
      automaticDownloads,
      channel,
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, this.#filePath)
  }
}

function readPreferences(filePath: string): {
  readonly automaticDownloads: boolean
  readonly channel: WorkbenchUpdateChannel
} {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    return {
      automaticDownloads:
        typeof parsed['automaticDownloads'] === 'boolean'
          ? parsed['automaticDownloads']
          : true,
      channel: isWorkbenchUpdateChannel(parsed['channel']) ? parsed['channel'] : 'stable',
    }
  } catch {
    return { automaticDownloads: true, channel: 'stable' }
  }
}
