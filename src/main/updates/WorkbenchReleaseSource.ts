import { isPlainObject } from '@velaros-ai/core'

import {
  isWorkbenchUpdateChannel,
  type WorkbenchUpdateChannel,
} from '../../shared/workbenchUpdate'

import {
  StaticWorkbenchCloudEndpointProvider,
  type WorkbenchCloudEndpointProvider,
} from './WorkbenchCloudEndpointResolver'

export const VelarOSCloudBaseUrl = 'https://global.velaros.cn/api'

export type WorkbenchReleaseSignatureStatus =
  | 'unsigned'
  | 'signed'
  | 'notarized'
  | 'verified'

export interface WorkbenchReleaseArtifact {
  readonly id: string
  readonly softwareProduct: 'workbench'
  readonly artifactRole: 'installer' | 'update-package' | 'update-metadata'
  readonly format: string
  readonly version: string
  readonly channel: string
  readonly platform: string
  readonly arch: string
  readonly fileName: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly signatureStatus: WorkbenchReleaseSignatureStatus
  readonly attestationVerified: boolean
  readonly isCurrent: boolean
  readonly downloadPath: string
}

export interface WorkbenchReleaseCatalog {
  readonly product: 'workbench'
  readonly channel: string
  readonly updatePolicy: 'optional' | 'required'
  readonly artifacts: readonly WorkbenchReleaseArtifact[]
}

export interface ResolvedWorkbenchReleaseCatalog {
  readonly baseUrl: string
  readonly catalog: WorkbenchReleaseCatalog
}

export interface WorkbenchReleaseSource {
  getCurrentRelease(input: {
    readonly channel: WorkbenchUpdateChannel
    readonly platform: NodeJS.Platform
    readonly arch: string
  }): Promise<ResolvedWorkbenchReleaseCatalog>
  fetchArtifact(
    input: {
      readonly baseUrl: string
      readonly downloadPath: string
    },
    init?: RequestInit
  ): Promise<Response>
}

function expectedPackage(platform: NodeJS.Platform): Nullable<{
  readonly format: string
  readonly role: WorkbenchReleaseArtifact['artifactRole']
}> {
  if (platform === 'darwin') return { format: 'zip', role: 'update-package' }
  if (platform === 'win32') return { format: 'exe', role: 'installer' }
  if (platform === 'linux') return { format: 'appimage', role: 'installer' }
  return null
}

export function validateWorkbenchReleaseCatalog(
  value: unknown,
  input: {
    readonly channel: WorkbenchUpdateChannel
    readonly platform: NodeJS.Platform
    readonly arch: string
  }
): WorkbenchReleaseCatalog {
  if (
    !isPlainObject(value) ||
    value['product'] !== 'workbench' ||
    value['channel'] !== input.channel ||
    (value['updatePolicy'] !== 'optional' && value['updatePolicy'] !== 'required') ||
    !Array.isArray(value['artifacts'])
  ) {
    throw new Error('Workbench update catalog identity is invalid.')
  }
  const catalog = value as unknown as WorkbenchReleaseCatalog
  if (catalog.artifacts.length === 0) return catalog

  const expected = expectedPackage(input.platform)
  if (!expected) throw new Error('Workbench update platform is unsupported.')
  const names = new Set<string>()
  const versions = new Set<string>()
  for (const artifact of catalog.artifacts) {
    if (
      !isPlainObject(artifact) ||
      typeof artifact.id !== 'string' ||
      !artifact.id ||
      artifact.softwareProduct !== 'workbench' ||
      (artifact.artifactRole !== 'installer' &&
        artifact.artifactRole !== 'update-package' &&
        artifact.artifactRole !== 'update-metadata') ||
      typeof artifact.format !== 'string' ||
      !artifact.format ||
      typeof artifact.version !== 'string' ||
      !artifact.version ||
      artifact.channel !== input.channel ||
      artifact.platform !== input.platform ||
      artifact.arch !== input.arch ||
      !artifact.isCurrent ||
      !artifact.attestationVerified ||
      (artifact.signatureStatus !== 'signed' &&
        artifact.signatureStatus !== 'notarized' &&
        artifact.signatureStatus !== 'verified') ||
      typeof artifact.fileName !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(artifact.fileName) ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      typeof artifact.downloadPath !== 'string' ||
      !/^\/v1\/releases\/download\/[A-Za-z0-9._~%-]+$/u.test(artifact.downloadPath) ||
      names.has(artifact.fileName)
    ) {
      throw new Error('Workbench update catalog failed integrity validation.')
    }
    names.add(artifact.fileName)
    versions.add(artifact.version)
  }
  const metadata = catalog.artifacts.filter(
    (artifact) => artifact.artifactRole === 'update-metadata' && artifact.format === 'yml'
  )
  const hasPackage = catalog.artifacts.some(
    (artifact) =>
      artifact.artifactRole === expected.role &&
      artifact.format.toLowerCase() === expected.format
  )
  if (versions.size !== 1 || metadata.length !== 1 || !hasPackage) {
    throw new Error('Workbench update catalog is incomplete.')
  }
  return catalog
}

export class CloudWorkbenchReleaseSource implements WorkbenchReleaseSource {
  public constructor(
    private readonly endpoints: WorkbenchCloudEndpointProvider =
      new StaticWorkbenchCloudEndpointProvider(VelarOSCloudBaseUrl),
    private readonly request: typeof fetch = fetch
  ) {}

  public async getCurrentRelease(input: {
    readonly channel: WorkbenchUpdateChannel
    readonly platform: NodeJS.Platform
    readonly arch: string
  }): Promise<ResolvedWorkbenchReleaseCatalog> {
    if (!isWorkbenchUpdateChannel(input.channel)) throw new Error('Update channel is invalid.')
    const search = new URLSearchParams({
      product: 'workbench',
      channel: input.channel,
      platform: input.platform,
      arch: input.arch,
    })
    let lastError: unknown
    for (const baseUrl of await this.endpoints.candidates()) {
      try {
        const response = await this.request(`${baseUrl}/v1/releases/current?${search}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`Update catalog returned HTTP ${response.status}.`)
        const catalog = validateWorkbenchReleaseCatalog(await response.json(), input)
        this.endpoints.markHealthy(baseUrl)
        return { baseUrl, catalog }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('No trusted Workbench update endpoint is available.')
  }

  public async fetchArtifact(
    input: { readonly baseUrl: string; readonly downloadPath: string },
    init?: RequestInit
  ): Promise<Response> {
    if (!(await this.endpoints.candidates()).includes(input.baseUrl)) {
      throw new Error('Update artifact base URL is not trusted.')
    }
    if (!/^\/v1\/releases\/download\/[A-Za-z0-9._~%-]+$/u.test(input.downloadPath)) {
      throw new Error('Update artifact path is not trusted.')
    }
    const response = await this.request(`${input.baseUrl}${input.downloadPath}`, {
      ...init,
      method: 'GET',
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`Update artifact returned HTTP ${response.status}.`)
    this.endpoints.markHealthy(input.baseUrl)
    return response
  }
}
