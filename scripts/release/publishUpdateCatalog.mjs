import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const FileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u

function requireEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to publish Workbench updates`)
  return value
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sortCanonicalValue(value[key])]),
    )
  }
  return value
}

function artifactDescriptor(fileName) {
  const lower = fileName.toLowerCase()
  const platform = lower.startsWith('latest-mac') || lower.includes('-mac-')
    ? 'darwin'
    : lower.startsWith('latest-linux') || lower.includes('-linux-')
      ? 'linux'
      : lower.startsWith('latest') || lower.includes('-win-')
        ? 'win32'
        : null
  if (!platform) return null
  const format = lower.endsWith('.blockmap')
    ? 'blockmap'
    : lower.endsWith('.yml') || lower.endsWith('.yaml')
      ? 'yml'
      : lower.endsWith('.dmg')
        ? 'dmg'
        : lower.endsWith('.zip')
          ? 'zip'
          : lower.endsWith('.exe')
            ? 'exe'
            : lower.endsWith('.appimage')
              ? 'appimage'
              : null
  if (!format) return null
  const artifactRole = format === 'yml' || format === 'blockmap'
    ? 'update-metadata'
    : format === 'zip'
      ? 'update-package'
      : 'installer'
  return {
    platform,
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    format,
    artifactRole,
    signatureStatus: artifactRole === 'update-metadata'
      ? 'verified'
      : platform === 'darwin'
        ? 'notarized'
        : platform === 'win32'
          ? 'signed'
          : 'verified',
  }
}

class ReleaseClient {
  constructor(repository, token) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error('VELAROS_RELEASE_REPOSITORY must be owner/repository')
    }
    this.repository = repository
    this.token = token
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'workbench-release',
        ...options.headers,
      },
    })
    if (options.allowNotFound && response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`)
    if (response.status === 204) return null
    const contentType = response.headers.get('content-type') ?? ''
    return contentType.includes('json') ? response.json() : response.arrayBuffer()
  }

  async ensurePublicRelease(tag, version, sourceCommit) {
    const repository = await this.request(`https://api.github.com/repos/${this.repository}`)
    if (repository.private !== false || repository.visibility !== 'public') {
      throw new Error(`${this.repository} must remain public`)
    }
    const existing = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
      { allowNotFound: true },
    )
    if (existing) return existing
    return this.request(`https://api.github.com/repos/${this.repository}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: `Workbench v${version} candidate`,
        body: `Public Workbench update candidate from ${sourceCommit}.`,
        draft: false,
        prerelease: true,
        make_latest: 'false',
      }),
    })
  }

  async upload(release, fileName, bytes) {
    const existing = release.assets.find((asset) => asset.name === fileName)
    if (existing) {
      const body = Buffer.from(await this.request(existing.url, {
        headers: { Accept: 'application/octet-stream' },
      }))
      if (body.length !== bytes.length || !body.equals(bytes)) {
        throw new Error(`${release.tag_name} already contains different bytes for ${fileName}`)
      }
      return String(existing.id)
    }
    const uploadUrl = release.upload_url.replace(/\{.*$/u, '')
    const asset = await this.request(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    release.assets.push(asset)
    return String(asset.id)
  }
}

function signCatalog(payload) {
  const keyId = requireEnvironment('VELAROS_RELEASE_ATTESTATION_KEY_ID')
  const privateKey = createPrivateKey({
    key: Buffer.from(requireEnvironment('VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY'), 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Workbench release attestation key must be Ed25519')
  }
  return {
    ...payload,
    attestation: {
      algorithm: 'ed25519',
      keyId,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(sortCanonicalValue(payload)), 'utf8'),
        privateKey,
      ).toString('base64url'),
    },
  }
}

async function ingestCatalog(catalog) {
  const destination = new URL(requireEnvironment('VELAROS_RELEASE_CATALOG_URL'))
  if (destination.protocol !== 'https:') throw new Error('Release catalog ingest must use HTTPS')
  const response = await fetch(destination, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireEnvironment('VELAROS_RELEASE_INGEST_TOKEN')}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
    },
    body: JSON.stringify(catalog),
  })
  if (!response.ok) throw new Error(`Cloud candidate ingest failed with HTTP ${response.status}`)
}

async function run() {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const version = manifest.version
  const sourceCommit = requireEnvironment(
    process.env.RELEASE_SOURCE_SHA ? 'RELEASE_SOURCE_SHA' : 'GITHUB_SHA',
  )
  const channel = process.env.VELAROS_UPDATE_CHANNEL?.trim() || 'stable'
  if (!['stable', 'beta', 'canary'].includes(channel)) {
    throw new Error(`Unsupported Workbench update channel: ${channel}`)
  }
  const releaseDirectory = path.resolve(repoRoot, process.argv[2] ?? 'artifacts/release-stage/final')
  const files = (await readdir(releaseDirectory))
    .filter((fileName) => FileNamePattern.test(fileName) && artifactDescriptor(fileName))
    .sort()
  if (files.length === 0) throw new Error('No Workbench update artifacts were staged')
  const client = new ReleaseClient(
    requireEnvironment('VELAROS_RELEASE_REPOSITORY'),
    requireEnvironment('VELAROS_RELEASE_REPO_TOKEN'),
  )
  const tag = `workbench-v${version}`
  const release = await client.ensurePublicRelease(tag, version, sourceCommit)
  const artifacts = []
  for (const fileName of files) {
    const descriptor = artifactDescriptor(fileName)
    const body = await readFile(path.join(releaseDirectory, fileName))
    const assetId = await client.upload(release, fileName, body)
    artifacts.push({
      kind: 'software',
      softwareProduct: 'workbench',
      ...descriptor,
      version,
      channel,
      assetId,
      fileName,
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
      githubTag: tag,
      sourceCommit,
    })
  }
  const catalog = signCatalog({ schemaVersion: 1, artifacts })
  const catalogName = `candidate-workbench-v${version}-${channel}.json`
  await writeFile(path.join(releaseDirectory, catalogName), `${JSON.stringify(catalog, null, 2)}\n`)
  await client.upload(release, catalogName, Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`))
  await ingestCatalog(catalog)
  console.info(`Workbench ${version} ${channel} update catalog uploaded and ingested; admin promotion remains explicit.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { artifactDescriptor, sortCanonicalValue }
