import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

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

export class WorkbenchReleaseFeedServer {
  readonly #token = randomBytes(32).toString('hex')
  readonly #artifactsByName: ReadonlyMap<string, WorkbenchReleaseArtifact>
  readonly #activeStreams = new Set<Readable>()
  #server: Nullable<Server> = null
  #paused = false

  public constructor(
    private readonly source: WorkbenchReleaseSource,
    private readonly release: ResolvedWorkbenchReleaseCatalog
  ) {
    const artifacts = new Map(
      release.catalog.artifacts.map((artifact) => [artifact.fileName, artifact])
    )
    const metadata = release.catalog.artifacts.find(
      (artifact) => artifact.artifactRole === 'update-metadata' && artifact.format === 'yml'
    )
    const canonicalName = metadata ? canonicalMetadataName(metadata.platform) : null
    if (metadata && canonicalName) artifacts.set(canonicalName, metadata)
    this.#artifactsByName = artifacts
  }

  public async listen(): Promise<string> {
    if (this.#server) throw new Error('Workbench update feed is already listening.')
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response)
    })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, LoopbackHost, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    return `http://${LoopbackHost}:${address.port}/${this.#token}/`
  }

  public pause(): void {
    this.#paused = true
    for (const stream of this.#activeStreams) stream.pause()
  }

  public resume(): void {
    this.#paused = false
    for (const stream of this.#activeStreams) stream.resume()
  }

  public async close(): Promise<void> {
    const server = this.#server
    this.#server = null
    this.resume()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return this.#finish(response, 405)
      if (request.headers.range) return this.#finish(response, 416)
      const requestUrl = new URL(request.url ?? '/', `http://${LoopbackHost}`)
      const prefix = `/${this.#token}/`
      if (!requestUrl.pathname.startsWith(prefix)) return this.#finish(response, 404)
      const encodedName = requestUrl.pathname.slice(prefix.length)
      if (!encodedName || encodedName.includes('/')) return this.#finish(response, 404)
      const artifact = this.#artifactsByName.get(decodeURIComponent(encodedName))
      if (!artifact) return this.#finish(response, 404)

      response.setHeader('Cache-Control', 'private, no-store')
      response.setHeader('Content-Type', artifact.format === 'yml' ? 'text/yaml; charset=utf-8' : 'application/octet-stream')
      response.setHeader('Content-Length', String(artifact.sizeBytes))
      response.setHeader('X-Content-Type-Options', 'nosniff')
      if (request.method === 'HEAD') {
        response.statusCode = 200
        response.end()
        return
      }

      const abort = new AbortController()
      request.once('aborted', () => abort.abort())
      const upstream = await this.source.fetchArtifact(
        { baseUrl: this.release.baseUrl, downloadPath: artifact.downloadPath },
        { signal: abort.signal }
      )
      if (!upstream.body) throw new Error('Update artifact response has no body.')
      response.statusCode = 200
      if (artifact.format === 'yml') {
        const body = Buffer.from(await upstream.arrayBuffer())
        const digest = createHash('sha256').update(body).digest('hex')
        if (body.byteLength !== artifact.sizeBytes || digest !== artifact.sha256) {
          throw new Error('Update metadata does not match the verified catalog.')
        }
        response.end(body)
        return
      }

      const stream = Readable.fromWeb(upstream.body as never)
      this.#activeStreams.add(stream)
      const releaseStream = (): void => {
        this.#activeStreams.delete(stream)
      }
      stream.once('close', releaseStream)
      stream.once('end', releaseStream)
      stream.once('error', (error) => response.destroy(error))
      stream.pipe(response)
      if (this.#paused) stream.pause()
    } catch (error) {
      if (!response.headersSent) this.#finish(response, 502)
      else response.destroy(error instanceof Error ? error : undefined)
    }
  }

  #finish(response: ServerResponse, statusCode: number): void {
    response.statusCode = statusCode
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Content-Length', '0')
    response.end()
  }
}
