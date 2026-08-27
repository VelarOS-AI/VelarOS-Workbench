import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface WorkbenchUpdatePreferencesFile {
  readonly version: 1
  readonly automaticDownloads: boolean
}

export class WorkbenchUpdatePreferencesStore {
  readonly #filePath: string
  #automaticDownloads: boolean

  public constructor(dataRootDir: string) {
    this.#filePath = join(dataRootDir, 'storage', 'update-preferences.json')
    this.#automaticDownloads = readAutomaticDownloads(this.#filePath)
  }

  public get automaticDownloads(): boolean {
    return this.#automaticDownloads
  }

  public setAutomaticDownloads(enabled: boolean): void {
    if (this.#automaticDownloads === enabled) return
    this.#automaticDownloads = enabled
    const file: WorkbenchUpdatePreferencesFile = {
      version: 1,
      automaticDownloads: enabled,
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    const temporaryPath = `${this.#filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, this.#filePath)
  }
}

function readAutomaticDownloads(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<
      WorkbenchUpdatePreferencesFile
    >
    return parsed.version === 1 && typeof parsed.automaticDownloads === 'boolean'
      ? parsed.automaticDownloads
      : true
  } catch {
    return true
  }
}
