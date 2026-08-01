import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import ts from 'typescript'

export async function readReleaseVersions(repoRoot) {
  const rootManifest = await readJson(path.join(repoRoot, 'package.json'))
  const appManifest = await readJson(path.join(repoRoot, 'apps/workbench/package.json'))
  const lockfile = await readJsonc(path.join(repoRoot, 'bun.lock'))
  const rootVersion = requireVersion(rootManifest, 'root package')
  const appVersion = requireVersion(appManifest, 'Workbench app')
  const lockedAppVersion = lockfile.workspaces?.['apps/workbench']?.version

  if (appVersion !== rootVersion) {
    throw new Error(`Workbench app version ${appVersion} must equal root version ${rootVersion}.`)
  }
  if (lockedAppVersion !== appVersion) {
    throw new Error(
      `bun.lock app version ${lockedAppVersion ?? '<missing>'} must equal ${appVersion}.`
    )
  }
  assertWorkspaceLockMatchesManifest(
    appManifest,
    lockfile.workspaces?.['apps/workbench'],
    'Workbench app'
  )
  return {
    rootVersion,
    appManifest,
    appVersion,
    releaseTag: `v${rootVersion}`,
  }
}

export async function validateReleaseSource({
  repoRoot,
  releaseTag,
  sourceSha,
  requireClean = true,
  requireTagRef = true,
}) {
  const versions = await readReleaseVersions(repoRoot)
  if (releaseTag !== versions.releaseTag) {
    throw new Error(
      `Release tag ${releaseTag || '<empty>'} must equal root version tag ${versions.releaseTag}.`
    )
  }

  const headSha = git(repoRoot, ['rev-parse', 'HEAD'])
  if (!sourceSha) throw new Error('Source SHA is required.')
  if (headSha !== sourceSha) {
    throw new Error(`HEAD ${headSha} must equal source SHA ${sourceSha}.`)
  }
  if (requireClean) {
    const status = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status) throw new Error(`Release source tree must be clean:\n${status}`)
  }
  if (requireTagRef) {
    const tagSha = git(repoRoot, ['rev-parse', `refs/tags/${releaseTag}^{commit}`])
    if (tagSha !== sourceSha) {
      throw new Error(`Tag ${releaseTag} resolves to ${tagSha}, not source SHA ${sourceSha}.`)
    }
  }
  return { ...versions, sourceSha }
}

export async function fileIdentity(file) {
  const bytes = await readFile(file)
  const metadata = await stat(file)
  return {
    fileName: path.basename(file),
    sizeBytes: metadata.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export function assertSameFileIdentity(actual, expected, label = expected.fileName) {
  if (
    actual.fileName !== expected.fileName
    || actual.sizeBytes !== expected.sizeBytes
    || actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      `${label} identity conflict: expected ${expected.sizeBytes}/${expected.sha256}, `
      + `received ${actual.sizeBytes}/${actual.sha256}.`
    )
  }
}

function requireVersion(manifest, label) {
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`${label} version is missing.`)
  }
  return manifest.version
}

function assertWorkspaceLockMatchesManifest(manifest, lockedWorkspace, label) {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const expected = manifest[field] ?? {}
    const actual = lockedWorkspace?.[field] ?? {}
    if (JSON.stringify(sortedEntries(actual)) !== JSON.stringify(sortedEntries(expected))) {
      throw new Error(
        `bun.lock ${label} ${field} must exactly match package.json; regenerate bun.lock.`
      )
    }
  }
}

function sortedEntries(record) {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function readJsonc(file) {
  const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'))
  if (parsed.error) {
    throw new Error(`Unable to parse ${file}: TypeScript diagnostic ${parsed.error.code}.`)
  }
  return parsed.config
}

function git(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
    )
  }
  return result.stdout.trim()
}
