import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  ResolvedWorkbenchReleaseCatalog,
  WorkbenchReleaseArtifact,
  WorkbenchReleaseSource,
} from './WorkbenchReleaseSource'

const LoopbackHost = '127.0.0.1'

function canonicalMetadataName(platform: string): Nullable<string> {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'win32') return 'latest.yml'
  if (platform === 'linux') return 'latest-linux.yml'
  return null
}

/** 单次更新检查持有的本机发布源；关闭回执覆盖监听端口和在途传输。 */
interface WorkbenchReleaseFeedServerApi {
  listen(): Promise<string>
  close(): Promise<void>
}

/** 将 Cloud 产物编号映射为更新器的同目录文件，随机路径仅在回环地址开放。 */
export class WorkbenchReleaseFeedServer implements WorkbenchReleaseFeedServerApi {
  readonly #log = Log.tag('WorkbenchReleaseFeedServer')
  readonly #token = randomBytes(32).toString('hex')
  readonly #artifactsByName: ReadonlyMap<string, WorkbenchReleaseArtifact>
  readonly #requests = new Map<AbortController, Promise<void>>()
  readonly #activeStreams = new Set<Readable>()
  #paused = false
  #server?: Server
  #listening?: Promise<string>
  #closing?: Promise<void>
  #closed = false

  public constructor(
    private readonly source: WorkbenchReleaseSource,
    private readonly releases: ResolvedWorkbenchReleaseCatalog,
    private readonly cachedArtifact?: (
      artifact: WorkbenchReleaseArtifact,
      range?: { start: number; end: number }
    ) => Nullable<Readable>
  ) {
    const artifacts = new Map(
      releases.catalog.artifacts.map((artifact) => [artifact.fileName, artifact])
    )
    const metadata = releases.catalog.artifacts.find(
      (artifact) => artifact.artifactRole === 'update-metadata' && artifact.format === 'yml'
    )
    const canonicalName = metadata ? canonicalMetadataName(metadata.platform) : undefined
    if (metadata && canonicalName) artifacts.set(canonicalName, metadata)
    this.#artifactsByName = artifacts
  }

  public listen(): Promise<string> {
    if (this.#closed) return Promise.reject(new AppError('INVARIANT', 'Update feed has closed.'))
    if (this.#listening) return this.#listening
    const server = createServer((request, response) => {
      if (this.#closed) {
        response.destroy()
        return
      }
      const controller = new AbortController()
      const operation = Promise.resolve()
        .then(() => this.#handleRequest(request, response, controller))
        .finally(() => {
          this.#requests.delete(controller)
        })
      this.#requests.set(controller, operation)
    })
    this.#server = server
    this.#listening = new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LoopbackHost, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (this.#closed || !address || typeof address === 'string') {
          reject(new AppError('INVARIANT', 'Update feed closed during startup.'))
          return
        }
        resolve(`http://${LoopbackHost}:${address.port}/${this.#token}/`)
      })
    })
    return this.#listening
  }

  public pause(): void {
    this.#paused = true
    for (const stream of this.#activeStreams) stream.pause()
  }

  public resume(): void {
    this.#paused = false
    for (const stream of this.#activeStreams) stream.resume()
  }

  public close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    // 先发布关闭回执，取消通知中的重入复用本次收尾。
    this.#closing = Promise.resolve().then(async () => {
      await Promise.allSettled(this.#listening ? [this.#listening] : [])
      const server = this.#server
      this.#server = undefined
      if (server)
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
      await Promise.allSettled(this.#requests.values())
    })
    for (const controller of this.#requests.keys()) controller.abort()
    return this.#closing
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    controller: AbortController
  ): Promise<void> {
    const { signal } = controller
    const cancel = (): void => {
      controller.abort()
    }
    const disconnect = (): void => {
      if (!response.writableFinished) cancel()
    }
    request.once('aborted', cancel)
    response.once('close', disconnect)
    try {
      signal.throwIfAborted()
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        this.#finish(response, 405)
        return
      }
      const requestUrl = new URL(request.url ?? '/', `http://${LoopbackHost}`)
      const prefix = `/${this.#token}/`
      const encodedName = requestUrl.pathname.startsWith(prefix)
        ? requestUrl.pathname.slice(prefix.length)
        : ''
      if (!encodedName || encodedName.includes('/')) {
        this.#finish(response, 404)
        return
      }
      const artifact = this.#artifactsByName.get(decodeURIComponent(encodedName))
      if (!artifact) {
        this.#finish(response, 404)
        return
      }
      let range: { start: number; end: number } | undefined
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range)
        const start = Number(match?.[1])
        const end = match?.[2] ? Number(match[2]) : artifact.sizeBytes - 1
        if (
          artifact.format === 'yml' ||
          !match ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          end >= artifact.sizeBytes
        ) {
          response.setHeader('Content-Range', `bytes */${artifact.sizeBytes}`)
          this.#finish(response, 416)
          return
        }
        range = { start, end }
        response.statusCode = 206
        response.setHeader('Content-Range', `bytes ${start}-${end}/${artifact.sizeBytes}`)
      }
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Cache-Control', 'private, no-store')
      response.setHeader(
        'Content-Type',
        artifact.format === 'yml' ? 'text/yaml; charset=utf-8' : 'application/octet-stream'
      )
      response.setHeader(
        'Content-Length',
        String(range ? range.end - range.start + 1 : artifact.sizeBytes)
      )
      response.setHeader('X-Content-Type-Options', 'nosniff')
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      const cached = this.cachedArtifact?.(artifact, range)
      if (cached) {
        await this.#pipe(cached, response, signal)
        return
      }
      const upstream = await this.source.fetchArtifact(
        {
          baseUrl: this.releases.baseUrl,
          downloadPath: artifact.downloadPath,
        },
        {
          signal,
          headers: request.headers.range
            ? {
                Range: request.headers.range,
                'If-Range': String(request.headers['if-range'] ?? ''),
              }
            : {},
        }
      )
      if (signal.aborted) {
        await upstream.body?.cancel(signal.reason)
        signal.throwIfAborted()
      }
      if (range && upstream.status === 200) {
        response.statusCode = 200
        response.removeHeader('Content-Range')
        response.setHeader('Content-Length', String(artifact.sizeBytes))
      } else if (range && upstream.status === 206) {
        if (
          upstream.headers.get('content-range') !==
          `bytes ${range.start}-${range.end}/${artifact.sizeBytes}`
        ) {
          await upstream.body?.cancel()
          throw new AppError('SECURITY', 'Invalid upstream update range.')
        }
      } else if (upstream.status !== 200) {
        await upstream.body?.cancel()
        throw new AppError('NETWORK', 'Unexpected update response status.')
      }
      if (!upstream.body) throw new AppError('NETWORK', '更新产物响应为空。')
      const stream = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>, { signal })
      if (artifact.format === 'yml') {
        const chunks: Buffer[] = []
        const hash = createHash('sha256')
        let size = 0
        // 元数据通过完整性校验后才交付更新器，并按已签名长度限制读取。
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk)
          size += bytes.byteLength
          if (size > artifact.sizeBytes)
            throw new AppError('SECURITY', '更新元数据与已验证目录不一致。')
          hash.update(bytes)
          chunks.push(bytes)
        }
        if (size !== artifact.sizeBytes || hash.digest('hex') !== artifact.sha256)
          throw new AppError('SECURITY', '更新元数据与已验证目录不一致。')
        response.end(Buffer.concat(chunks, size))
        return
      }
      await this.#pipe(stream, response, signal)
    } catch (error) {
      if (signal.aborted) {
        response.destroy()
        return
      }
      this.#log.caught('release feed request failed', error)
      if (response.destroyed) return
      if (!response.headersSent) this.#finish(response, 502)
      else response.destroy(error instanceof Error ? error : undefined)
    } finally {
      request.off('aborted', cancel)
      response.off('close', disconnect)
    }
  }

  async #pipe(stream: Readable, response: ServerResponse, signal: AbortSignal): Promise<void> {
    this.#activeStreams.add(stream)
    try {
      const operation = pipeline(stream, response, { signal })
      if (this.#paused) stream.pause()
      await operation
    } finally {
      this.#activeStreams.delete(stream)
    }
  }

  #finish(response: ServerResponse, statusCode: number): void {
    response.statusCode = statusCode
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Content-Length', '0')
    response.end()
  }
}
