// 更新产物持久缓存：只向安装器交付完整且通过目录 SHA-256 校验的文件。
import { createHash } from 'node:crypto'
import { constants, createReadStream, type ReadStream } from 'node:fs'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchReleaseArtifact } from './WorkbenchReleaseSource'

export class WorkbenchUpdateDownloadCache {
  public constructor(private readonly directory: string) {}

  public async clear(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    for (const entry of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.partial$/u.test(entry))
        await rm(join(this.directory, entry), { force: true })
    }
  }

  public stream(path: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(path, range)
  }

  public async download(
    artifact: WorkbenchReleaseArtifact,
    fetchArtifact: (init: RequestInit) => Promise<Response>,
    signal: AbortSignal,
    onProgress: (transferred: number) => void
  ): Promise<string> {
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          artifact.version,
          artifact.platform,
          artifact.arch,
          artifact.fileName,
          artifact.sizeBytes,
          artifact.sha256,
        ])
      )
      .digest('hex')
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, `${identity}.partial`)
    // 单一更新任务持有缓存；仅保留当前身份，避免跨版本大文件无限增长。
    for (const entry of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.partial$/u.test(entry) && entry !== `${identity}.partial`)
        await rm(join(this.directory, entry), { force: true })
    }
    const file = await open(path, constants.O_CREAT | constants.O_RDWR)
    try {
      let offset = (await file.stat()).size
      if (offset > artifact.sizeBytes) {
        await file.truncate(0)
        offset = 0
      }
      signal.throwIfAborted()
      onProgress(offset)
      if (offset < artifact.sizeBytes) {
        const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
        if (offset > 0) headers.Range = `bytes=${offset}-`
        const response = await fetchArtifact({ signal, headers }).catch((error: unknown) => {
          throw new AppError('NETWORK', AppError.getMessage(error), error)
        })
        try {
          signal.throwIfAborted()
          if (response.status === 200) {
            // 不支持 Range 时只能安全重下，绝不能把完整响应追加到旧前缀。
            await file.truncate(0)
            offset = 0
          } else if (response.status === 206) {
            const range = response.headers.get('content-range')
            if (range !== `bytes ${offset}-${artifact.sizeBytes - 1}/${artifact.sizeBytes}`)
              throw new AppError('SECURITY', 'Invalid update Content-Range.')
          } else {
            throw new AppError('NETWORK', `Update download returned HTTP ${response.status}.`)
          }
          if (!response.body) throw new AppError('NETWORK', 'Empty update response.')
          const reader = response.body.getReader()
          try {
            for (;;) {
              const result = await reader.read().catch((error: unknown) => {
                throw new AppError('NETWORK', AppError.getMessage(error), error)
              })
              if (result.done) break
              const chunk = result.value
              signal.throwIfAborted()
              if (offset + chunk.byteLength > artifact.sizeBytes)
                throw new AppError('SECURITY', 'Update exceeds verified size.')
              let written = 0
              while (written < chunk.byteLength) {
                const result = await file.write(
                  chunk,
                  written,
                  chunk.byteLength - written,
                  offset + written
                )
                written += result.bytesWritten
              }
              offset += chunk.byteLength
              onProgress(offset)
            }
          } finally {
            reader.releaseLock()
          }
        } finally {
          if (!response.body?.locked)
            await response.body?.cancel().catch((error: unknown) => {
              Log.tag('WorkbenchUpdateDownloadCache').caught(
                'update response cleanup failed',
                error
              )
            })
        }
      }
      await file.sync()
      signal.throwIfAborted()
      if ((await file.stat()).size !== artifact.sizeBytes)
        throw new AppError('NETWORK', 'Incomplete update download; retry to resume.')
    } finally {
      await file.close()
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
    if (hash.digest('hex') !== artifact.sha256) {
      await rm(path, { force: true })
      throw new AppError('SECURITY', 'Update SHA-256 mismatch.')
    }
    return path
  }
}
