import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  canonicalizeWorkbenchCloudRoutingManifest,
  type SignedWorkbenchCloudRoutingManifest,
  WorkbenchCloudEndpointResolver,
  WorkbenchCloudRoutingManifestFileStore,
  type WorkbenchCloudRoutingManifestPayload,
  type WorkbenchCloudRoutingManifestStore,
  workbenchCloudRoutingManifestUrls,
  WorkbenchCloudRoutingMinimumRevision,
  WorkbenchCloudRoutingPublicKeySpki,
} from '../src/main/updates/WorkbenchCloudEndpointResolver'
import { resolveVelarOSOfficialWebsiteMarket } from '../src/main/VelarOSOfficialWebsite'

const FixedNow = new Date('2026-09-03T00:00:00.000Z')
const EmbeddedBaseUrl = 'https://embedded.example.com/api'
const temporaryRoots: string[] = []

const ProductionRoutingManifest: SignedWorkbenchCloudRoutingManifest = {
  schemaVersion: 1,
  revision: 3,
  market: 'cn',
  cloudOrigins: [
    {
      id: 'cn-beijing-1',
      baseUrl: 'https://8.152.209.233/api',
      priority: 100,
      enabled: true,
      dataSourceId: 'c5dadce4-ea62-48c9-aac7-5b73dfaa0fe4',
    },
  ],
  websiteBaseUrl: 'https://velaros.cn',
  issuedAt: '2026-09-02T09:16:22.840Z',
  expiresAt: '2026-12-01T09:16:22.840Z',
  attestation: {
    algorithm: 'ed25519',
    keyId: 'routing-S56HpANKY-Wx6wC0',
    signature:
      'Y_tfHQRsLWGDeOgPCYQ96iDdezY29NIC3wGGE0m87N82zhzqeiprzLlXqL0Vvn5wEA6l2h_54keMJoFOQI4UCw',
  },
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function createSignedManifest(
  payload: WorkbenchCloudRoutingManifestPayload,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
): SignedWorkbenchCloudRoutingManifest {
  return {
    ...payload,
    attestation: {
      algorithm: 'ed25519',
      keyId: 'routing-test',
      signature: sign(
        null,
        Buffer.from(canonicalizeWorkbenchCloudRoutingManifest(payload), 'utf8'),
        privateKey
      ).toString('base64url'),
    },
  }
}

function createPayload(
  overrides: Partial<WorkbenchCloudRoutingManifestPayload> = {}
): WorkbenchCloudRoutingManifestPayload {
  return {
    schemaVersion: 1,
    revision: 4,
    market: 'cn',
    issuedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-10-03T00:00:00.000Z',
    cloudOrigins: [
      {
        id: 'secondary',
        baseUrl: 'https://secondary.example.com/api',
        priority: 50,
        enabled: true,
        dataSourceId: 'shared-source',
      },
      {
        id: 'primary',
        baseUrl: 'https://8.152.209.233/api',
        priority: 100,
        enabled: true,
        dataSourceId: 'shared-source',
      },
    ],
    ...overrides,
  }
}

function missingStore(): WorkbenchCloudRoutingManifestStore {
  return {
    load: async () => {
      const error = new Error('missing') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    },
    save: async () => undefined,
  }
}

describe('WorkbenchCloudEndpointResolver', () => {
  test('accepts signed routes, remembers the healthy origin, and reuses a private cache offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-cloud-routing-'))
    temporaryRoots.push(root)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const manifest = createSignedManifest(createPayload(), privateKey)
    const store = new WorkbenchCloudRoutingManifestFileStore(root, 'cn')
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: store,
      fetchImpl: (async () => Response.json(manifest)) as typeof fetch,
      now: () => FixedNow,
    })

    expect(await resolver.candidates()).toEqual([
      'https://8.152.209.233/api',
      'https://secondary.example.com/api',
      EmbeddedBaseUrl,
    ])
    resolver.markHealthy('https://secondary.example.com/api')
    expect(await resolver.candidates()).toEqual([
      'https://secondary.example.com/api',
      'https://8.152.209.233/api',
      EmbeddedBaseUrl,
    ])
    expect(resolver.currentBaseUrl()).toBe('https://secondary.example.com/api')
    resolver.markHealthy(EmbeddedBaseUrl)
    expect((await resolver.candidates())[0]).toBe(EmbeddedBaseUrl)
    expect(resolver.currentBaseUrl()).toBe(EmbeddedBaseUrl)

    const cachePath = join(root, 'storage', 'cloud-routing-cn.json')
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600)

    const offlineResolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: store,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
      now: () => FixedNow,
    })
    expect(await offlineResolver.candidates()).toEqual([
      'https://8.152.209.233/api',
      'https://secondary.example.com/api',
      EmbeddedBaseUrl,
    ])
  })

  test('rejects tampered, wrong-market, expired, and below-minimum manifests', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const valid = createSignedManifest(createPayload(), privateKey)
    const cases: SignedWorkbenchCloudRoutingManifest[] = [
      {
        ...valid,
        revision: valid.revision + 1,
      },
      createSignedManifest(createPayload({ market: 'global' }), privateKey),
      createSignedManifest(
        createPayload({ expiresAt: '2026-09-02T23:59:59.000Z' }),
        privateKey
      ),
      createSignedManifest(createPayload({ revision: 1 }), privateKey),
      createSignedManifest(
        createPayload({
          cloudOrigins: createPayload().cloudOrigins.map((origin) => ({
            ...origin,
            enabled: false,
          })),
        }),
        privateKey
      ),
      createSignedManifest(
        createPayload({
          cloudOrigins: [
            createPayload().cloudOrigins[0]!,
            {
              ...createPayload().cloudOrigins[1]!,
              id: createPayload().cloudOrigins[0]!.id,
            },
          ],
        }),
        privateKey
      ),
      createSignedManifest(
        createPayload({
          cloudOrigins: [
            createPayload().cloudOrigins[0]!,
            {
              ...createPayload().cloudOrigins[1]!,
              dataSourceId: 'different-source',
            },
          ],
        }),
        privateKey
      ),
      createSignedManifest(
        createPayload({ websiteBaseUrl: 'https://velaros.cn/untrusted-path' }),
        privateKey
      ),
      createSignedManifest(createPayload({ websiteBaseUrl: '' }), privateKey),
    ]

    for (const manifest of cases) {
      const resolver = new WorkbenchCloudEndpointResolver({
        market: 'cn',
        embeddedBaseUrl: EmbeddedBaseUrl,
        manifestUrls: ['https://config.example.com/routing.json'],
        routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        minimumRevision: 2,
        manifestStore: missingStore(),
        fetchImpl: (async () => Response.json(manifest)) as typeof fetch,
        now: () => FixedNow,
      })
      expect(await resolver.candidates()).toEqual([EmbeddedBaseUrl])
    }
  })

  test('keeps a newer cached revision when a signed route attempts to downgrade it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const cached = createSignedManifest(createPayload({ revision: 5 }), privateKey)
    const downgraded = createSignedManifest(
      createPayload({
        revision: 4,
        cloudOrigins: [
          {
            id: 'downgraded',
            baseUrl: 'https://downgraded.example.com/api',
            priority: 100,
            enabled: true,
            dataSourceId: 'shared-source',
          },
        ],
      }),
      privateKey
    )
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: {
        load: async () => cached,
        save: async () => undefined,
      },
      fetchImpl: (async () => Response.json(downgraded)) as typeof fetch,
      now: () => FixedNow,
    })

    expect(await resolver.candidates()).toEqual([
      'https://8.152.209.233/api',
      'https://secondary.example.com/api',
      EmbeddedBaseUrl,
    ])
  })

  test('shares concurrent cache loading and refresh so callers receive one route snapshot', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const cached = createSignedManifest(createPayload({ revision: 4 }), privateKey)
    const refreshed = createSignedManifest(
      createPayload({
        revision: 5,
        cloudOrigins: [
          {
            id: 'refreshed',
            baseUrl: 'https://refreshed.example.com/api',
            priority: 100,
            enabled: true,
            dataSourceId: 'shared-source',
          },
        ],
      }),
      privateKey
    )
    let releaseCache!: () => void
    let releaseFetch!: () => void
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve
    })
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let cacheLoads = 0
    let fetches = 0
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: {
        load: async () => {
          cacheLoads += 1
          await cacheGate
          return cached
        },
        save: async () => undefined,
      },
      fetchImpl: (async () => {
        fetches += 1
        await fetchGate
        return Response.json(refreshed)
      }) as typeof fetch,
      now: () => FixedNow,
    })

    const first = resolver.candidates()
    const second = resolver.candidates()
    await Promise.resolve()
    expect(cacheLoads).toBe(1)
    releaseCache()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetches).toBe(1)
    releaseFetch()

    expect(await Promise.all([first, second])).toEqual([
      ['https://refreshed.example.com/api', EmbeddedBaseUrl],
      ['https://refreshed.example.com/api', EmbeddedBaseUrl],
    ])
  })

  test('stops trusting expired routes during a long-running process', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const manifest = createSignedManifest(createPayload(), privateKey)
    let now = FixedNow
    let fetches = 0
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: missingStore(),
      fetchImpl: (async () => {
        fetches += 1
        if (fetches === 1) return Response.json(manifest)
        throw new TypeError('fetch failed')
      }) as typeof fetch,
      now: () => now,
    })

    expect((await resolver.candidates())[0]).toBe('https://8.152.209.233/api')
    resolver.markHealthy('https://secondary.example.com/api')
    now = new Date('2026-10-04T00:00:00.000Z')
    expect(await resolver.candidates()).toEqual([EmbeddedBaseUrl])
    expect(resolver.currentBaseUrl()).toBe(EmbeddedBaseUrl)
  })

  test('ignores an untrusted healthy hint and accepts the current production signature', async () => {
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: WorkbenchCloudRoutingPublicKeySpki,
      minimumRevision: WorkbenchCloudRoutingMinimumRevision,
      manifestStore: missingStore(),
      fetchImpl: (async () => Response.json(ProductionRoutingManifest)) as typeof fetch,
      now: () => FixedNow,
    })

    expect(await resolver.candidates()).toEqual([
      'https://8.152.209.233/api',
      EmbeddedBaseUrl,
    ])
    resolver.markHealthy('https://attacker.example.com/api')
    expect(await resolver.candidates()).toEqual([
      'https://8.152.209.233/api',
      EmbeddedBaseUrl,
    ])
  })

  test('uses an explicit local override without reading or refreshing signed routes', async () => {
    let cacheLoads = 0
    let fetches = 0
    const { publicKey } = generateKeyPairSync('ed25519')
    const resolver = new WorkbenchCloudEndpointResolver({
      market: 'cn',
      embeddedBaseUrl: EmbeddedBaseUrl,
      overrideBaseUrl: 'http://127.0.0.1:8787/api/',
      manifestUrls: ['https://config.example.com/routing.json'],
      routingPublicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      minimumRevision: 2,
      manifestStore: {
        load: async () => {
          cacheLoads += 1
          return null
        },
        save: async () => undefined,
      },
      fetchImpl: (async () => {
        fetches += 1
        throw new Error('should not fetch')
      }) as typeof fetch,
      now: () => FixedNow,
    })

    expect(await resolver.candidates()).toEqual(['http://127.0.0.1:8787/api'])
    expect(resolver.currentBaseUrl()).toBe('http://127.0.0.1:8787/api')
    expect(cacheLoads).toBe(0)
    expect(fetches).toBe(0)
  })

  test('resolves market and signed-manifest publication order like Desktop', () => {
    expect(
      resolveVelarOSOfficialWebsiteMarket({
        configuredMarket: undefined,
        locale: 'zh-CN',
        timeZone: 'America/Los_Angeles',
      })
    ).toBe('cn')
    expect(
      resolveVelarOSOfficialWebsiteMarket({
        configuredMarket: 'global',
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      })
    ).toBe('global')
    expect(workbenchCloudRoutingManifestUrls('cn')).toEqual([
      'https://8.152.209.233/velaros-desktop-routing.cn.json',
      'https://global.velaros.cn/velaros-desktop-routing.cn.json',
    ])
  })
})
