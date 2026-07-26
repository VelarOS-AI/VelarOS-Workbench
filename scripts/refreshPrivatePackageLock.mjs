import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]
const ignoredDirectories = new Set([
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
])
const supportedArguments = new Set(['--validate-only'])
const unexpectedArguments = process.argv.slice(2).filter(
  (argument) => !supportedArguments.has(argument)
)

if (unexpectedArguments.length > 0) {
  throw new Error(`Unsupported arguments: ${unexpectedArguments.join(', ')}`)
}

const bunRuntime = Reflect.get(globalThis, 'Bun')
if (
  typeof bunRuntime?.JSONC?.parse !== 'function' ||
  typeof bunRuntime?.semver?.satisfies !== 'function'
) {
  throw new Error('This script requires Bun.JSONC and Bun.semver.')
}

const manifests = await readPackageManifests(repositoryRoot)
const workspacePackageNames = new Set(
  manifests.map(({ manifest }) => manifest.name).filter(Boolean)
)
const requirements = collectExternalVelarPackageRequirements(
  manifests,
  workspacePackageNames
)
const packageNames = [...new Set(requirements.map(({ packageName }) => packageName))].sort()

if (packageNames.length === 0) {
  throw new Error('No external @velaros-ai packages were found in repository manifests.')
}

if (!process.argv.includes('--validate-only')) {
  await updatePrivatePackages(requirements, manifests)
}
await validateLockfile(requirements)

console.info(
  `Private package lock is valid for ${packageNames.length} package(s): ${packageNames.join(', ')}`
)

async function readPackageManifests(directory) {
  const manifestPaths = await collectManifestPaths(directory)
  return Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const source = await readFile(manifestPath, 'utf8')
      return {
        manifest: JSON.parse(source),
        manifestPath,
        source,
        workspaceKey: toWorkspaceKey(manifestPath),
      }
    })
  )
}

async function collectManifestPaths(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedPaths = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) return []
        return collectManifestPaths(path.join(directory, entry.name))
      }
      return entry.isFile() && entry.name === 'package.json'
        ? [path.join(directory, entry.name)]
        : []
    })
  )
  return nestedPaths.flat().sort()
}

function toWorkspaceKey(manifestPath) {
  const relativeDirectory = path.relative(repositoryRoot, path.dirname(manifestPath))
  return relativeDirectory.split(path.sep).join('/')
}

function collectExternalVelarPackageRequirements(packageManifests, ownPackageNames) {
  const packageRequirements = []
  for (const { manifest, manifestPath, workspaceKey } of packageManifests) {
    for (const field of dependencyFields) {
      for (const [packageName, range] of Object.entries(manifest[field] ?? {})) {
        if (
          !packageName.startsWith('@velaros-ai/') ||
          ownPackageNames.has(packageName) ||
          range.startsWith('workspace:')
        ) {
          continue
        }
        packageRequirements.push({
          field,
          manifestPath,
          packageName,
          range,
          workspaceKey,
        })
      }
    }
  }
  return packageRequirements.sort((left, right) =>
    `${left.packageName}:${left.workspaceKey}:${left.field}`.localeCompare(
      `${right.packageName}:${right.workspaceKey}:${right.field}`
    )
  )
}

async function updatePrivatePackages(packageRequirements, packageManifests) {
  const packageNamesByManifest = new Map()
  for (const { manifestPath, packageName } of packageRequirements) {
    const packageNames = packageNamesByManifest.get(manifestPath) ?? new Set()
    packageNames.add(packageName)
    packageNamesByManifest.set(manifestPath, packageNames)
  }

  const manifestUpdates = [...packageNamesByManifest.entries()].sort(
    ([leftManifest], [rightManifest]) => leftManifest.localeCompare(rightManifest)
  )
  for (const [manifestPath, packageNameSet] of manifestUpdates) {
    const exactPackageNames = [...packageNameSet].sort()
    const result = spawnSync(
      'bun',
      [
        'update',
        ...exactPackageNames,
        '--lockfile-only',
        '--ignore-scripts',
      ],
      {
        cwd: path.dirname(manifestPath),
        env: process.env,
        stdio: 'inherit',
      }
    )
    if (result.status !== 0) {
      const manifest = path.relative(repositoryRoot, manifestPath)
      throw new Error(
        `bun update failed for ${manifest}${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}`
      )
    }
    await assertManifestSourcesUnchanged(packageManifests)
  }
}

async function assertManifestSourcesUnchanged(packageManifests) {
  for (const { manifestPath, source } of packageManifests) {
    const currentSource = await readFile(manifestPath, 'utf8')
    if (currentSource !== source) {
      throw new Error(
        `bun update changed ${path.relative(repositoryRoot, manifestPath)}; only bun.lock may change.`
      )
    }
  }
}

async function validateLockfile(packageRequirements) {
  const lockfilePath = path.join(repositoryRoot, 'bun.lock')
  const lockfile = bunRuntime.JSONC.parse(await readFile(lockfilePath, 'utf8'))

  for (const requirement of packageRequirements) {
    validateWorkspaceRequirement(lockfile, requirement)
    validateResolvedVersion(lockfile, requirement)
  }
}

function validateWorkspaceRequirement(lockfile, requirement) {
  const lockedRange =
    lockfile.workspaces?.[requirement.workspaceKey]?.[requirement.field]?.[
      requirement.packageName
    ]
  if (lockedRange !== requirement.range) {
    throw new Error(
      `${formatRequirement(requirement)} is recorded as ${String(lockedRange)} in bun.lock.`
    )
  }
}

function validateResolvedVersion(lockfile, requirement) {
  const resolution = lockfile.packages?.[requirement.packageName]?.[0]
  const prefix = `${requirement.packageName}@`
  if (typeof resolution !== 'string' || !resolution.startsWith(prefix)) {
    throw new Error(
      `${formatRequirement(requirement)} has no canonical package resolution in bun.lock.`
    )
  }

  const resolvedVersion = resolution.slice(prefix.length)
  if (!bunRuntime.semver.satisfies(resolvedVersion, requirement.range)) {
    throw new Error(
      `${formatRequirement(requirement)} resolves to ${resolvedVersion}, which does not satisfy ${requirement.range}.`
    )
  }
}

function formatRequirement(requirement) {
  const manifest = path.relative(repositoryRoot, requirement.manifestPath)
  return `${manifest}#${requirement.field}.${requirement.packageName}`
}
