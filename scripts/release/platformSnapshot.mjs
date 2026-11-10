// 用途：准备并核对已发布依赖与具有不可变来源证明的本机候选快照。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const platformSnapshotDirectory = 'build/runtime-packages'
const PlatformRepository = 'VelarOS-AI/VelarOS-Platform'
const UiRepository = 'VelarOS-AI/VelarOS-UI'
const CommitPattern = /^[a-f0-9]{40}$/u
const Sha256Pattern = /^[a-f0-9]{64}$/u
const ArchiveNamePattern = /^[a-z0-9][a-z0-9._-]*\.tgz$/u

export function platformSnapshotSpecification(entry) {
  return `file:${platformSnapshotDirectory}/${entry.sha256}/${entry.fileName}`
}

/** 依赖身份来自正式发布 URL；哈希缓存只负责本地字节核验和恢复。 */
export function platformSnapshotDependencySpecification(snapshot, entry) {
  const source = snapshot.sources[entry.source]
  if (source?.kind === 'github-release')
    return `https://github.com/${source.repository}/releases/download/${encodeURIComponent(source.tag)}/${entry.fileName}`
  if (source?.kind === 'frozen-local-candidate') return platformSnapshotSpecification(entry)
  throw new Error(`Invalid dependency snapshot source: ${entry.source}`)
}

export function isPlatformSnapshotDependencySpecification(value) {
  return typeof value === 'string' && (
    /^file:build\/runtime-packages\/[a-f0-9]{64}\/[a-z0-9][a-z0-9._-]*\.tgz$/u.test(value) ||
    /^https:\/\/github\.com\/VelarOS-AI\/VelarOS-(?:Platform|UI)\/releases\/download\/[^/]+\/[a-z0-9][a-z0-9._-]*\.tgz$/u.test(value)
  )
}

function assertCapabilityBaseDependency(snapshot, entry, manifest) {
  if (entry.name !== '@velaros-ai/capabilities') return
  const base = snapshot.packages.find((item) => item.name === '@velaros-ai/velaros')
  if (
    !base ||
    base.version !== entry.version ||
    manifest?.dependencies?.['@velaros-ai/velaros'] !== platformSnapshotDependencySpecification(snapshot, base) ||
    Object.hasOwn(manifest.peerDependencies ?? {}, '@velaros-ai/velaros')
  )
    throw new Error('Capabilities must declare the canonical mandatory base archive dependency without a registry peer.')
}

export function verifyPlatformSnapshotLock(snapshot, lockfile) {
  for (const entry of snapshot.packages) {
    const specification = platformSnapshotDependencySpecification(snapshot, entry)
    const locked = lockfile.packages?.[entry.name]
    const resolutions = Object.values(lockfile.packages ?? {}).filter(
      (candidate) => typeof candidate?.[0] === 'string' && candidate[0].startsWith(`${entry.name}@`)
    )
    if (
      locked?.[0] !== `${entry.name}@${specification.replace(/^file:/u, '')}` ||
      locked.at(-1) !== entry.integrity ||
      resolutions.length !== 1 ||
      Object.hasOwn(lockfile.overrides ?? {}, entry.name)
    )
      throw new Error(`Platform snapshot lock identity mismatch: ${entry.name}`)
    assertCapabilityBaseDependency(snapshot, entry, locked[1])
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function metadataReferenceIsValid(reference) {
  return (
    isRecord(reference) &&
    typeof reference.path === 'string' &&
    reference.path.startsWith('resources/runtime-sources/') &&
    reference.path.split('/').every((segment) => /^[a-z0-9][a-z0-9._-]*$/u.test(segment)) &&
    Sha256Pattern.test(reference.sha256 ?? '')
  )
}

async function readPlatformSnapshot(root) {
  const snapshot = JSON.parse(await readFile(path.join(root, 'resources/runtime-snapshot.json'), 'utf8'))
  if (
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== 2 ||
    !isRecord(snapshot.sources) ||
    Object.keys(snapshot.sources).length === 0 ||
    !Array.isArray(snapshot.packages) ||
    snapshot.packages.length === 0
  )
    throw new Error('Invalid Platform snapshot source identity')

  for (const [key, source] of Object.entries(snapshot.sources)) {
    if (
      !/^[a-z][a-z0-9-]*$/u.test(key) ||
      !isRecord(source) ||
      ![PlatformRepository, UiRepository].includes(source.repository) ||
      !CommitPattern.test(source.sourceCommit ?? '')
    )
      throw new Error(`Invalid dependency snapshot source: ${key}`)
    if (source.kind === 'github-release') {
      if (!/^v\d+\.\d+\.\d+$/u.test(source.tag ?? ''))
        throw new Error(`Invalid GitHub release source: ${key}`)
    } else if (source.kind === 'frozen-local-candidate') {
      if (
        source.repository !== PlatformRepository ||
        Object.hasOwn(source, 'tag') ||
        !CommitPattern.test(source.sourceTree ?? '') ||
        !Sha256Pattern.test(source.rawInputFingerprint ?? '') ||
        !Sha256Pattern.test(source.committedInputFingerprint ?? '') ||
        !metadataReferenceIsValid(source.receipt) ||
        !metadataReferenceIsValid(source.commitProof)
      )
        throw new Error(`Invalid frozen candidate source: ${key}`)
    } else {
      throw new Error(`Unsupported dependency snapshot source: ${key}`)
    }
  }

  const names = new Set()
  const usedSources = new Set()
  for (const entry of snapshot.packages) {
    if (!isRecord(entry)) throw new Error('Invalid Platform snapshot package')
    const source = snapshot.sources[entry.source]
    if (
      !/^@velaros-ai\/[a-z][a-z0-9-]*$/u.test(entry.name ?? '') ||
      !/^\d+\.\d+\.\d+$/u.test(entry.version ?? '') ||
      !ArchiveNamePattern.test(entry.fileName ?? '') ||
      !Sha256Pattern.test(entry.sha256 ?? '') ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? '') ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes <= 0 ||
      names.has(entry.name)
    )
      throw new Error(`Invalid Platform snapshot package: ${entry.name}`)
    if (
      typeof entry.source !== 'string' ||
      !Object.hasOwn(snapshot.sources, entry.source) ||
      source.repository !== (entry.name === '@velaros-ai/ui' ? UiRepository : PlatformRepository) ||
      (entry.name === '@velaros-ai/ui' && source.tag !== `v${entry.version}`)
    )
      throw new Error(`Invalid dependency snapshot source: ${entry.name}`)
    names.add(entry.name)
    usedSources.add(entry.source)
  }
  if (usedSources.size !== Object.keys(snapshot.sources).length)
    throw new Error('Snapshot contains an unused dependency source')
  return snapshot
}

async function readRegularFile(file) {
  if (!(await lstat(file)).isFile()) throw new Error(`Snapshot must be a regular file: ${file}`)
  return readFile(file)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readMetadata(root, reference) {
  const bytes = await readRegularFile(path.join(root, reference.path))
  if (sha256(bytes) !== reference.sha256)
    throw new Error(`Snapshot metadata integrity mismatch: ${reference.path}`)
  return JSON.parse(bytes.toString('utf8'))
}

function archiveMatches(archive, entry) {
  return archive?.name === entry.fileName &&
    archive.package === entry.name &&
    archive.version === entry.version &&
    archive.bytes === entry.sizeBytes &&
    archive.sha256 === entry.sha256 &&
    archive.integrity === entry.integrity
}

function validateCandidateProvenance(source, receipt, proof, packages) {
  if (
    !isRecord(receipt) ||
    !isRecord(proof) ||
    receipt.kind !== 'verified-local-candidate' ||
    receipt.frozen !== true ||
    receipt.sourceCommit !== source.sourceCommit ||
    receipt.source?.fingerprint !== source.rawInputFingerprint ||
    receipt.source?.commitTree !== source.sourceTree ||
    receipt.source?.committedInputFingerprint !== source.committedInputFingerprint ||
    receipt.source?.committedInputsMatch !== true ||
    typeof receipt.source?.dirty !== 'boolean' ||
    proof.sourceCommit !== source.sourceCommit ||
    proof.tree !== source.sourceTree ||
    proof.rawCandidateFingerprint !== source.rawInputFingerprint ||
    proof.committedInputFingerprint !== source.committedInputFingerprint ||
    !Number.isSafeInteger(proof.inputFiles) ||
    proof.inputFiles <= 0 ||
    proof.inputFiles !== receipt.source?.inputFiles ||
    !Array.isArray(proof.inputs) ||
    proof.inputs.length !== proof.inputFiles ||
    !/^\d+\.\d+$/u.test(receipt.platformGeneration ?? '') ||
    !Array.isArray(receipt.archives)
  )
    throw new Error('Frozen candidate commit proof does not match its declared source')
  for (const entry of packages) {
    if (
      entry.version !== receipt.version ||
      !receipt.archives.some((archive) => archiveMatches(archive, entry))
    )
      throw new Error(`Frozen candidate archive provenance mismatch: ${entry.name}`)
  }
  return receipt.platformGeneration
}

async function verifyArchive(file, entry, platformGeneration) {
  const bytes = await readRegularFile(file)
  if (
    bytes.length !== entry.sizeBytes ||
    sha256(bytes) !== entry.sha256 ||
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== entry.integrity
  )
    throw new Error(`Platform snapshot integrity mismatch: ${entry.name}`)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path.basename(file), 'package/package.json'], {
    cwd: path.dirname(file),
    encoding: 'utf8',
  }))
  if (
    manifest.name !== entry.name ||
    manifest.version !== entry.version ||
    (platformGeneration !== undefined && manifest.velaros?.platform !== platformGeneration)
  )
    throw new Error(`Platform snapshot package identity mismatch: ${entry.name}`)
  if (Object.hasOwn(manifest, 'overrides') || Object.hasOwn(manifest, 'resolutions'))
    throw new Error(`Published library manifest must not contain development dependency mappings: ${entry.name}`)
  return manifest
}

function githubApi(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }))
}

function verifyPublishedSource(source, packages) {
  const prefix = `repos/${source.repository}`
  const release = githubApi(`${prefix}/releases/tags/${encodeURIComponent(source.tag)}`)
  if (release.tag_name !== source.tag || release.draft !== false || !release.published_at)
    throw new Error(`Dependency source is not a published GitHub release: ${source.repository} ${source.tag}`)
  let object = githubApi(`${prefix}/git/ref/tags/${encodeURIComponent(source.tag)}`).object
  while (object?.type === 'tag' && CommitPattern.test(object.sha))
    object = githubApi(`${prefix}/git/tags/${object.sha}`).object
  if (object?.type !== 'commit' || object.sha !== source.sourceCommit)
    throw new Error(`GitHub release tag does not match dependency source commit: ${source.tag}`)
  for (const entry of packages) {
    const asset = release.assets?.find((candidate) => candidate.name === entry.fileName)
    if (
      !asset || asset.state !== 'uploaded' || asset.size !== entry.sizeBytes ||
      (asset.digest && asset.digest !== `sha256:${entry.sha256}`)
    )
      throw new Error(`GitHub release asset identity mismatch: ${entry.name}`)
  }
}

export async function verifyPlatformSnapshot(root, { downloadMissing = false, requirePublished = false } = {}) {
  const snapshot = await readPlatformSnapshot(root)
  const candidate = Object.entries(snapshot.sources).find(([, source]) =>
    source.kind === 'frozen-local-candidate'
  )
  if (requirePublished && candidate)
    throw new Error(`Release builds require published dependency sources; frozen local candidate: ${candidate[0]}`)
  const generations = new Map()
  for (const [key, source] of Object.entries(snapshot.sources)) {
    const packages = snapshot.packages.filter((entry) => entry.source === key)
    if (source.kind === 'frozen-local-candidate') {
      generations.set(key, validateCandidateProvenance(
        source, await readMetadata(root, source.receipt), await readMetadata(root, source.commitProof), packages
      ))
    } else if (requirePublished) {
      verifyPublishedSource(source, packages)
    }
  }
  for (const entry of snapshot.packages) {
    const source = snapshot.sources[entry.source]
    const archive = path.join(root, platformSnapshotSpecification(entry).slice('file:'.length))
    try {
      await lstat(archive)
    } catch (error) {
      if (error.code !== 'ENOENT' || !downloadMissing) throw error
      if (source.kind === 'frozen-local-candidate')
        throw new Error(`Missing frozen candidate archive; use --import-candidate explicitly: ${entry.name}`)
      const archiveDirectory = path.dirname(archive)
      await mkdir(archiveDirectory, { recursive: true })
      const staging = await mkdtemp(path.join(archiveDirectory, '.download-'))
      try {
        execFileSync('gh', [
          'release', 'download', source.tag, '--repo', source.repository,
          '--pattern', entry.fileName, '--dir', staging,
        ], { stdio: 'inherit' })
        const downloaded = path.join(staging, entry.fileName)
        await verifyArchive(downloaded, entry)
        await rename(downloaded, archive)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    const manifest = await verifyArchive(archive, entry, generations.get(entry.source))
    assertCapabilityBaseDependency(snapshot, entry, manifest)
  }
  return snapshot
}

async function copyImmutable(source, destination, expectedSha256) {
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (sha256(await readRegularFile(destination)) !== expectedSha256)
    throw new Error(`Immutable snapshot identity conflict: ${destination}`)
}

/** 来源先由受审查的 snapshot 声明；导入只复制已核实的原始字节，不改来源、归档或锁文件。 */
export async function importPlatformCandidate(root, receiptFile) {
  const snapshot = await readPlatformSnapshot(root)
  const receiptBytes = await readRegularFile(receiptFile)
  const sourceEntry = Object.entries(snapshot.sources).find(([, source]) =>
    source.kind === 'frozen-local-candidate' && source.receipt.sha256 === sha256(receiptBytes)
  )
  if (!sourceEntry) throw new Error('Candidate receipt is not declared by the current snapshot')
  const [key, source] = sourceEntry
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  const proofName = receipt.source?.commitProof?.replaceAll('\\', '/').split('/').at(-1)
  if (!proofName || !/^[a-z0-9][a-z0-9._-]*\.json$/u.test(proofName))
    throw new Error('Invalid candidate commit proof filename')
  const directory = path.dirname(path.resolve(receiptFile))
  const proofFile = path.join(directory, proofName)
  const proofBytes = await readRegularFile(proofFile)
  if (sha256(proofBytes) !== source.commitProof.sha256)
    throw new Error('Candidate commit proof integrity mismatch')
  const packages = snapshot.packages.filter((entry) => entry.source === key)
  const generation = validateCandidateProvenance(source, receipt, JSON.parse(proofBytes.toString('utf8')), packages)
  for (const entry of packages) await verifyArchive(path.join(directory, entry.fileName), entry, generation)
  await copyImmutable(receiptFile, path.join(root, source.receipt.path), source.receipt.sha256)
  await copyImmutable(proofFile, path.join(root, source.commitProof.path), source.commitProof.sha256)
  for (const entry of packages)
    await copyImmutable(path.join(directory, entry.fileName),
      path.join(root, platformSnapshotSpecification(entry).slice('file:'.length)), entry.sha256)
  return verifyPlatformSnapshot(root)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const args = process.argv.slice(2)
  let snapshot
  if (args.length === 2 && args[0] === '--import-candidate') {
    snapshot = await importPlatformCandidate(root, path.resolve(args[1]))
  } else if (args.length === 0 || (args.length === 1 && args[0] === '--verify-only')) {
    snapshot = await verifyPlatformSnapshot(root, { downloadMissing: args.length === 0 })
  } else {
    throw new Error(`Unsupported arguments: ${args.join(', ')}`)
  }
  console.info(`Verified ${snapshot.packages.length} dependency snapshot packages from ${Object.keys(snapshot.sources).join(', ')}`)
}
