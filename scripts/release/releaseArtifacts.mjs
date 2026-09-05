import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  assertSameFileIdentity,
  fileIdentity,
  readReleaseVersions,
  validateReleaseSource,
} from './releaseIdentity.mjs'

const platformNames = new Set(['macos', 'windows', 'linux'])
const supportedArchitectures = new Set(['arm64', 'x64'])
const execFileAsync = promisify(execFile)
const distributionPlatforms = {
  macos: 'darwin',
  windows: 'win32',
  linux: 'linux',
}

function normalizedArchitecture(arch) {
  if (!supportedArchitectures.has(arch)) {
    throw new Error(`Unsupported Workbench release architecture: ${arch}`)
  }
  return arch
}

function readDistributionIdentity(value, releasePlatform) {
  validatePlatform(releasePlatform)
  if (
    !value ||
    value.platform !== distributionPlatforms[releasePlatform] ||
    !supportedArchitectures.has(value.arch) ||
    !['unsigned', 'signed', 'notarized', 'verified'].includes(value.signatureStatus) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.some((entry) => typeof entry !== 'string' || !entry)
  ) {
    throw new Error(`Invalid ${releasePlatform} Workbench distribution identity.`)
  }
  return {
    platform: value.platform,
    arch: value.arch,
    signatureStatus: value.signatureStatus,
    evidence: [...value.evidence],
  }
}

function artifactDistributionDescriptor(name, platform, distribution) {
  distribution = readDistributionIdentity(distribution, platform)
  const lower = name.toLowerCase()
  if (!lower.startsWith('latest')) {
    const archMarkers =
      distribution.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64', 'amd64']
    if (!archMarkers.some((marker) => lower.includes(`-${marker}`))) {
      throw new Error(
        `${name} does not match verified Workbench architecture ${distribution.arch}.`
      )
    }
  }
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
            : lower.endsWith('.msi')
              ? 'msi'
              : lower.endsWith('.appimage')
                ? 'appimage'
                : lower.endsWith('.deb')
                  ? 'deb'
                  : lower.endsWith('.rpm')
                    ? 'rpm'
                    : lower.endsWith('.snap')
                      ? 'snap'
                      : null
  if (!format) throw new Error(`Unsupported Workbench release artifact: ${name}`)
  const artifactRole =
    format === 'yml' || format === 'blockmap'
      ? 'update-metadata'
      : format === 'zip'
        ? 'update-package'
        : 'installer'
  return {
    platform: distribution.platform,
    arch: distribution.arch,
    format,
    artifactRole,
    signatureStatus:
      artifactRole === 'update-metadata' ? 'verified' : distribution.signatureStatus,
  }
}

export async function readWorkbenchVersion(repoRoot) {
  return (await readReleaseVersions(repoRoot)).version
}

export async function validateReleaseTag(repoRoot, tag) {
  const versions = await readReleaseVersions(repoRoot)
  if (tag !== versions.releaseTag) {
    throw new Error(
      `Release tag ${tag || '<empty>'} must equal Workbench version tag ${versions.releaseTag}.`
    )
  }
  return versions.version
}

export async function stageReleaseArtifacts({
  releaseDir,
  stageDir,
  platform,
  distribution,
  version,
  sourceSha,
  releaseTag = `v${version}`,
}) {
  validatePlatform(platform)
  distribution = readDistributionIdentity(distribution, platform)
  if (!version || !sourceSha) {
    throw new Error('Workbench release staging requires version and sourceSha.')
  }
  if (releaseTag !== `v${version}`) {
    throw new Error(`Release tag ${releaseTag} must equal v${version}.`)
  }

  const artifacts = await collectPlatformArtifacts(releaseDir, platform, version)
  assertCompleteArtifactSet(artifacts, platform)
  await mkdir(stageDir, { recursive: true })
  const identities = []
  for (const name of artifacts) {
    const source = path.join(releaseDir, name)
    const target = path.join(stageDir, name)
    const sourceIdentity = await fileIdentity(source)
    assertNonEmptyArtifactIdentity(sourceIdentity, name)
    await copyImmutable(source, target)
    identities.push({
      sourceSha,
      version,
      ...artifactDistributionDescriptor(name, platform, distribution),
      ...sourceIdentity,
    })
  }
  identities.sort((left, right) => left.fileName.localeCompare(right.fileName))
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    version,
    releaseTag,
    platform,
    distribution: {
      platform: distribution.platform,
      arch: distribution.arch,
      signatureStatus: distribution.signatureStatus,
      evidence: [...distribution.evidence],
    },
    artifacts: identities,
  }
  const checksumName = `SHA256SUMS-${platform}.txt`
  const checksumBody = identities
    .map((identity) => `${identity.sha256}  ${identity.fileName}`)
    .join('\n')
  await writeImmutableText(path.join(stageDir, checksumName), `${checksumBody}\n`)
  const manifestName = releaseManifestName(platform)
  await writeImmutableText(
    path.join(stageDir, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  await validateStagedRelease({
    directory: stageDir,
    platform,
    version,
    sourceSha,
    releaseTag,
  })
  return [...artifacts, checksumName, manifestName]
}

export async function validateStagedRelease({
  directory,
  platform,
  version,
  sourceSha,
  releaseTag = `v${version}`,
}) {
  validatePlatform(platform)
  const manifestFile = path.join(directory, releaseManifestName(platform))
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (manifest.schemaVersion !== 2) throw new Error('Unknown Workbench release manifest schema.')
  for (const [field, expected] of Object.entries({
    sourceSha,
    version,
    releaseTag,
    platform,
  })) {
    if (manifest[field] !== expected) {
      throw new Error(
        `Workbench release manifest ${field} ${manifest[field] ?? '<missing>'} must equal ${expected}.`
      )
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`Workbench release manifest for ${platform} has no artifacts.`)
  }
  const distribution = readDistributionIdentity(manifest.distribution, platform)
  const names = manifest.artifacts.map((artifact) => artifact.fileName)
  if (new Set(names).size !== names.length) {
    throw new Error(`Workbench release manifest for ${platform} contains duplicate file names.`)
  }
  assertCompleteArtifactSet(names, platform)
  for (const artifact of manifest.artifacts) {
    assertNonEmptyArtifactIdentity(artifact, artifact.fileName)
    for (const [field, expected] of Object.entries({ sourceSha, version })) {
      if (artifact[field] !== expected) {
        throw new Error(
          `${artifact.fileName} ${field} ${artifact[field] ?? '<missing>'} must equal ${expected}.`
        )
      }
    }
    const expectedDistribution = artifactDistributionDescriptor(
      artifact.fileName,
      platform,
      distribution
    )
    for (const [field, expected] of Object.entries(expectedDistribution)) {
      if (artifact[field] !== expected) {
        throw new Error(
          `${artifact.fileName} ${field} ${artifact[field] ?? '<missing>'} must equal ${expected}.`
        )
      }
    }
    assertArtifactVersion(artifact.fileName, platform, version)
    const actual = await fileIdentity(path.join(directory, artifact.fileName))
    assertSameFileIdentity(actual, artifact, artifact.fileName)
  }
  const presentArtifacts = await collectPlatformArtifacts(directory, platform, version)
  if (presentArtifacts.join('\n') !== [...names].sort().join('\n')) {
    throw new Error(
      `Staged ${platform} files do not exactly match the immutable Workbench release manifest.`
    )
  }
  const expectedChecksums = manifest.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.fileName}`)
    .join('\n')
  const actualChecksums = await readFile(
    path.join(directory, `SHA256SUMS-${platform}.txt`),
    'utf8'
  )
  if (actualChecksums !== `${expectedChecksums}\n`) {
    throw new Error(`SHA256SUMS-${platform}.txt does not match the Workbench release manifest.`)
  }
  return manifest
}

export async function reuseReleaseArtifacts({
  existingDir,
  stageDir,
  platform,
  version,
  sourceSha,
  releaseTag = `v${version}`,
  distribution,
}) {
  validatePlatform(platform)
  const entries = await safeReadDirectory(existingDir)
  const manifestName = releaseManifestName(platform)
  const hasManifest = entries.includes(manifestName)
  const artifactNames = await collectPlatformArtifacts(existingDir, platform, version, {
    allowMissingDirectory: true,
  })
  if (!hasManifest && artifactNames.length === 0) return { reused: false, files: [] }

  if (!hasManifest) {
    assertCompleteArtifactSet(artifactNames, platform)
    const files = await stageReleaseArtifacts({
      releaseDir: existingDir,
      stageDir,
      platform,
      version,
      sourceSha,
      releaseTag,
      distribution,
    })
    const checksumName = `SHA256SUMS-${platform}.txt`
    if (entries.includes(checksumName)) {
      const [existingChecksum, stagedChecksum] = await Promise.all([
        fileIdentity(path.join(existingDir, checksumName)),
        fileIdentity(path.join(stageDir, checksumName)),
      ])
      assertSameFileIdentity(stagedChecksum, existingChecksum, checksumName)
    }
    return { adoptedCheckpoint: true, reused: true, files }
  }

  const checkpoint = JSON.parse(await readFile(path.join(existingDir, manifestName), 'utf8'))
  if (checkpoint.schemaVersion === 1) {
    if (!distribution) {
      throw new Error(`Legacy ${platform} Workbench checkpoint requires native verification.`)
    }
    await validateLegacyStagedRelease({
      directory: existingDir,
      manifest: checkpoint,
      platform,
      version,
      sourceSha,
      releaseTag,
    })
    const files = await stageReleaseArtifacts({
      releaseDir: existingDir,
      stageDir,
      platform,
      distribution,
      version,
      sourceSha,
      releaseTag,
    })
    return { adoptedCheckpoint: true, reused: true, files }
  }

  const manifest = await validateStagedRelease({
    directory: existingDir,
    platform,
    version,
    sourceSha,
    releaseTag,
  })
  await mkdir(stageDir, { recursive: true })
  const files = [
    ...manifest.artifacts.map((artifact) => artifact.fileName),
    `SHA256SUMS-${platform}.txt`,
    manifestName,
  ]
  for (const name of files) {
    await copyImmutable(path.join(existingDir, name), path.join(stageDir, name))
  }
  return { reused: true, files }
}

async function validateLegacyStagedRelease({
  directory,
  manifest,
  platform,
  version,
  sourceSha,
  releaseTag,
}) {
  for (const [field, expected] of Object.entries({
    schemaVersion: 1,
    sourceSha,
    version,
    releaseTag,
    platform,
  })) {
    if (manifest[field] !== expected) {
      throw new Error(
        `Legacy Workbench release manifest ${field} ${manifest[field] ?? '<missing>'} must equal ${expected}.`
      )
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`Legacy Workbench release manifest for ${platform} has no artifacts.`)
  }
  const names = manifest.artifacts.map((artifact) => artifact.fileName)
  if (new Set(names).size !== names.length) {
    throw new Error(`Legacy Workbench release manifest for ${platform} contains duplicates.`)
  }
  assertCompleteArtifactSet(names, platform)
  for (const artifact of manifest.artifacts) {
    assertNonEmptyArtifactIdentity(artifact, artifact.fileName)
    for (const [field, expected] of Object.entries({ sourceSha, version, platform })) {
      if (artifact[field] !== expected) {
        throw new Error(`Legacy ${artifact.fileName} ${field} must equal ${expected}.`)
      }
    }
    const actual = await fileIdentity(path.join(directory, artifact.fileName))
    assertSameFileIdentity(actual, artifact, artifact.fileName)
  }
}

export function releaseManifestName(platform) {
  validatePlatform(platform)
  return `workbench-${platform}-release.json`
}

export function assertCompleteArtifactSet(names, platform) {
  const has = (pattern) => names.some((name) => pattern.test(name))
  const required = {
    macos: [
      [/\.dmg$/i, 'DMG'],
      [/\.zip$/i, 'ZIP'],
      [/^latest-mac(?:-[^.]+)?\.ya?ml$/i, 'latest-mac YAML'],
    ],
    windows: [
      [/\.(?:exe|msi)$/i, 'installer'],
      [/^latest(?:-[^.]+)?\.ya?ml$/i, 'latest YAML'],
    ],
    linux: [
      [/\.AppImage$/i, 'AppImage'],
      [/\.(?:deb|rpm|snap)$/i, 'Linux package'],
      [/^latest-linux(?:-[^.]+)?\.ya?ml$/i, 'latest-linux YAML'],
    ],
  }[platform]
  const missing = required.filter(([pattern]) => !has(pattern)).map(([, label]) => label)
  if (missing.length > 0) {
    throw new Error(`Incomplete ${platform} release checkpoint; missing ${missing.join(', ')}.`)
  }
}

async function collectPlatformArtifacts(
  directory,
  platform,
  version,
  { allowMissingDirectory = false } = {}
) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (allowMissingDirectory && error?.code === 'ENOENT') return []
    throw error
  }
  const artifacts = entries
    .filter((entry) => entry.isFile() && isReleaseArtifact(entry.name, platform))
    .map((entry) => entry.name)
    .sort()
  for (const name of artifacts) {
    assertArtifactVersion(name, platform, version)
    if (/^latest/i.test(name)) {
      const body = await readFile(path.join(directory, name), 'utf8')
      const yamlVersion = body.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
      if (!yamlVersion) throw new Error(`${name} does not declare a version.`)
      if (yamlVersion !== version) {
        throw new Error(`${name} version ${yamlVersion} must equal ${version}; mixed releases fail.`)
      }
    }
  }
  return artifacts
}

async function findApplicationBundle(root, depth = 0) {
  if (depth > 5) return null
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return path.join(root, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findApplicationBundle(path.join(root, entry.name), depth + 1)
    if (found) return found
  }
  return null
}

async function verifyMacDistribution(releaseDir, version, execute) {
  const artifacts = await collectPlatformArtifacts(releaseDir, 'macos', version)
  const dmgFiles = artifacts.filter((name) => name.toLowerCase().endsWith('.dmg'))
  const zipFile = artifacts.find((name) => name.toLowerCase().endsWith('.zip'))
  if (dmgFiles.length === 0 || !zipFile) {
    throw new Error('macOS Workbench distribution verification requires both DMG and ZIP.')
  }
  for (const name of dmgFiles) {
    const artifactPath = path.join(releaseDir, name)
    await execute('xcrun', ['stapler', 'validate', artifactPath])
    await execute('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      artifactPath,
    ])
  }

  const extractionRoot = await mkdtemp(path.join(tmpdir(), 'workbench-release-identity-'))
  try {
    await execute('ditto', ['-x', '-k', path.join(releaseDir, zipFile), extractionRoot])
    const application = await findApplicationBundle(extractionRoot)
    if (!application) throw new Error(`${zipFile} does not contain a Workbench application bundle.`)
    await execute('codesign', ['--verify', '--deep', '--strict', application])
    await execute('spctl', ['--assess', '--type', 'execute', application])
    const plistPath = path.join(application, 'Contents', 'Info.plist')
    const { stdout: executableName } = await execute('plutil', [
      '-extract',
      'CFBundleExecutable',
      'raw',
      '-o',
      '-',
      plistPath,
    ])
    const executablePath = path.join(application, 'Contents', 'MacOS', executableName.trim())
    if (!(await stat(executablePath)).isFile()) {
      throw new Error(`${zipFile} contains no executable declared by Info.plist.`)
    }
    const { stdout: architectures } = await execute('lipo', ['-archs', executablePath])
    const normalized = architectures
      .trim()
      .split(/\s+/u)
      .map((arch) => (arch === 'x86_64' ? 'x64' : arch))
      .filter(Boolean)
    if (normalized.length !== 1) {
      throw new Error(
        `Workbench update catalogs require one native architecture; ZIP contains ${normalized.join(', ')}.`
      )
    }
    return normalizedArchitecture(normalized[0])
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

async function resolveNativeDistributionIdentity({
  releaseDir,
  platform,
  version,
  host = { platform: process.platform, arch: process.arch },
  execute = execFileAsync,
}) {
  validatePlatform(platform)
  const expectedHost = distributionPlatforms[platform]
  if (host.platform !== expectedHost) {
    throw new Error(
      `${platform} Workbench release identity must be produced on ${expectedHost}; current host is ${host.platform}.`
    )
  }
  if (platform === 'macos') {
    const arch = await verifyMacDistribution(releaseDir, version, execute)
    return {
      platform: 'darwin',
      arch,
      signatureStatus: 'notarized',
      evidence: [
        'sha256',
        'mach-o-architecture',
        'codesign-strict',
        'gatekeeper-accepted',
        'notarization-stapled',
      ],
    }
  }
  const arch = normalizedArchitecture(host.arch)
  return {
    platform: expectedHost,
    arch,
    signatureStatus: platform === 'windows' ? 'unsigned' : 'verified',
    evidence: ['sha256', 'native-runner-architecture'],
  }
}

function assertArtifactVersion(name, platform, version) {
  if (/^latest/i.test(name)) return
  if (!name.startsWith(`VelarOS-Workbench-${version}-`)) {
    const detected = name.match(/^VelarOS-Workbench-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-/)?.[1]
    throw new Error(
      `${platform} artifact ${name} version ${detected ?? '<unknown>'} `
      + `must equal ${version}; mixed releases fail.`
    )
  }
}

function isReleaseArtifact(name, platform) {
  if (name.startsWith('SHA256SUMS-') || name.startsWith('workbench-')) return false
  if (platform === 'macos' && /^latest-mac(?:-[^.]+)?\.ya?ml$/i.test(name)) return true
  if (platform === 'windows' && /^latest\.ya?ml$/i.test(name)) return true
  if (platform === 'linux' && /^latest-linux(?:-[^.]+)?\.ya?ml$/i.test(name)) return true
  if (!name.startsWith('VelarOS-Workbench-')) return false
  const marker = {
    macos: '-mac-',
    windows: '-win-',
    linux: '-linux-',
  }[platform]
  if (!name.includes(marker)) return false
  switch (platform) {
    case 'macos':
      return /\.(?:dmg|zip|blockmap)$/i.test(name)
    case 'windows':
      return /\.(?:exe|msi|blockmap)$/i.test(name)
    case 'linux':
      return /\.(?:AppImage|deb|rpm|snap|blockmap)$/i.test(name)
    default:
      return false
  }
}

async function copyImmutable(source, target) {
  try {
    await access(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await copyFile(source, target, 0)
    return
  }
  const [actual, expected] = await Promise.all([fileIdentity(target), fileIdentity(source)])
  assertSameFileIdentity(actual, expected, path.basename(target))
}

async function writeImmutableText(target, body) {
  try {
    await writeFile(target, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readFile(target, 'utf8')
    if (existing !== body) {
      throw new Error(`${path.basename(target)} already exists with a different identity.`)
    }
  }
}

async function safeReadDirectory(directory) {
  try {
    return await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function validatePlatform(platform) {
  if (!platformNames.has(platform)) throw new Error(`Unknown release platform: ${platform}`)
}

function assertNonEmptyArtifactIdentity(identity, fileName) {
  if (
    !Number.isSafeInteger(identity?.sizeBytes) ||
    identity.sizeBytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(identity?.sha256 ?? '')
  ) {
    throw new Error(`${fileName} must be a non-empty Workbench release artifact.`)
  }
}

async function writeGithubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const repoRoot = process.cwd()
  if (command === 'validate-tag') {
    await validateReleaseTag(repoRoot, args[0] ?? process.env.RELEASE_TAG ?? '')
    return
  }
  if (command === 'validate-source') {
    await validateReleaseSource({
      repoRoot,
      releaseTag: args[0] ?? process.env.RELEASE_TAG ?? '',
      sourceSha: args[1] ?? releaseSourceSha(),
    })
    return
  }

  const versions = await validateReleaseSource({
    repoRoot,
    releaseTag: process.env.RELEASE_TAG ?? '',
    sourceSha: releaseSourceSha(),
  })
  if (command === 'stage') {
    const [platform, releaseDir = 'artifacts/desktop', stageDir = `artifacts/release-stage/${platform}`] = args
    const resolvedReleaseDir = path.resolve(repoRoot, releaseDir)
    const distribution = await resolveNativeDistributionIdentity({
      releaseDir: resolvedReleaseDir,
      platform,
      version: versions.version,
    })
    const staged = await stageReleaseArtifacts({
      releaseDir: resolvedReleaseDir,
      stageDir: path.resolve(repoRoot, stageDir),
      platform,
      distribution,
      version: versions.version,
      sourceSha: versions.sourceSha,
      releaseTag: versions.releaseTag,
    })
    console.info(`Staged ${staged.length} immutable ${platform} release files.`)
    return
  }
  if (command === 'reuse') {
    const [platform, existingDir = 'artifacts/release-existing', stageDir = `artifacts/release-stage/${platform}`] =
      args
    const resolvedExistingDir = path.resolve(repoRoot, existingDir)
    const entries = await safeReadDirectory(resolvedExistingDir)
    const existingManifestName = releaseManifestName(platform)
    const existingSchema = entries.includes(existingManifestName)
      ? JSON.parse(await readFile(path.join(resolvedExistingDir, existingManifestName), 'utf8'))
          .schemaVersion
      : null
    const distribution = existingSchema === 2
      ? undefined
      : await resolveNativeDistributionIdentity({
          releaseDir: resolvedExistingDir,
          platform,
          version: versions.version,
        })
    const result = await reuseReleaseArtifacts({
      existingDir: resolvedExistingDir,
      stageDir: path.resolve(repoRoot, stageDir),
      platform,
      distribution,
      version: versions.version,
      sourceSha: versions.sourceSha,
      releaseTag: versions.releaseTag,
    })
    await writeGithubOutput('reuse', result.reused ? 'true' : 'false')
    await writeGithubOutput('adopted_checkpoint', result.adoptedCheckpoint ? 'true' : 'false')
    console.info(
      result.reused ? `Reused ${platform} release checkpoint.` : 'No checkpoint found.'
    )
    return
  }
  if (command === 'verify') {
    const [platform, directory = 'artifacts/release-existing'] = args
    await validateStagedRelease({
      directory: path.resolve(repoRoot, directory),
      platform,
      version: versions.version,
      sourceSha: versions.sourceSha,
      releaseTag: versions.releaseTag,
    })
    console.info(`Verified immutable ${platform} release checkpoint.`)
    return
  }
  throw new Error(
    'Usage: appReleaseArtifacts.mjs '
    + 'validate-tag <tag> | validate-source | stage <platform> | reuse <platform> | verify <platform>'
  )
}

function releaseSourceSha() {
  return process.env.RELEASE_SOURCE_SHA ?? process.env.GITHUB_SHA ?? ''
}

export {
  artifactDistributionDescriptor,
  resolveNativeDistributionIdentity,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
