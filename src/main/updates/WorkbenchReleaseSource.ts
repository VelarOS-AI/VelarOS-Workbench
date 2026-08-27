export const VelarOSCloudBaseUrl = 'https://global.velaros.cn'

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

export class CloudWorkbenchReleaseSource implements WorkbenchReleaseSource {
  public async getCurrentRelease(input: {
    readonly platform: NodeJS.Platform
    readonly arch: string
  }): Promise<ResolvedWorkbenchReleaseCatalog> {
    const search = new URLSearchParams({
      product: 'workbench',
      channel: 'stable',
      platform: input.platform,
      arch: input.arch,
    })
    const response = await fetch(`${VelarOSCloudBaseUrl}/v1/releases/current?${search}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Update catalog returned HTTP ${response.status}.`)
    return {
      baseUrl: VelarOSCloudBaseUrl,
      catalog: (await response.json()) as WorkbenchReleaseCatalog,
    }
  }

  public async fetchArtifact(
    input: { readonly baseUrl: string; readonly downloadPath: string },
    init?: RequestInit
  ): Promise<Response> {
    if (input.baseUrl !== VelarOSCloudBaseUrl) {
      throw new Error('Update artifact base URL is not trusted.')
    }
    if (!/^\/v1\/releases\/download\/[A-Za-z0-9._~%-]+$/u.test(input.downloadPath)) {
      throw new Error('Update artifact path is not trusted.')
    }
    const response = await fetch(`${input.baseUrl}${input.downloadPath}`, {
      ...init,
      method: 'GET',
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`Update artifact returned HTTP ${response.status}.`)
    return response
  }
}
