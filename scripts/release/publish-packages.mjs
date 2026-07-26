import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertSameFileIdentity,
  fileIdentity,
  readReleaseVersions,
  validateReleaseSource,
} from './releaseIdentity.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const registry = 'https://npm.pkg.github.com'

export async function createPackageReleaseManifest({
  tarball,
  packageManifest,
  sourceSha,
  releaseTag,
}) {
  const identity = await fileIdentity(tarball)
  return {
    schemaVersion: 1,
    name: packageManifest.name,
    version: packageManifest.version,
    sourceSha,
    releaseTag,
    ...identity,
  }
}

export async function validatePackageReleaseManifest({
  tarball,
  manifest,
  packageManifest,
  sourceSha,
  releaseTag,
}) {
  if (manifest.schemaVersion !== 1) throw new Error('Unknown package release manifest schema.')
  for (const [field, expected] of Object.entries({
    name: packageManifest.name,
    version: packageManifest.version,
    sourceSha,
    releaseTag,
  })) {
    if (manifest[field] !== expected) {
      throw new Error(
        `Package release manifest ${field} ${manifest[field] ?? '<missing>'} must equal ${expected}.`
      )
    }
  }
  const identity = await fileIdentity(tarball)
  assertSameFileIdentity(identity, manifest, 'Package tarball')
  return manifest
}

export async function packUniqueTarball({ packageDirectory, outputDirectory }) {
  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(outputDirectory, { recursive: true })
  const result = runCapture(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory],
    packageDirectory
  )
  let packed
  try {
    packed = JSON.parse(result)
  } catch {
    throw new Error(`npm pack did not return JSON: ${result}`)
  }
  const declared = packed.map((entry) => entry.filename)
  const actual = (await readdir(outputDirectory))
    .filter((name) => name.endsWith('.tgz'))
    .sort()
  if (declared.length !== 1 || actual.length !== 1 || declared[0] !== actual[0]) {
    throw new Error(
      `Expected one unique package tarball, npm declared [${declared.join(', ')}] `
      + `and produced [${actual.join(', ')}].`
    )
  }
  return path.join(outputDirectory, actual[0])
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const requireClean = process.argv.includes('--require-clean') || !dryRun
  const requireTagRef = process.argv.includes('--require-tag-ref') || !dryRun
  const versions = await readReleaseVersions(root)
  const sourceSha = process.env.GITHUB_SHA || gitHead(root)
  const releaseTag = process.env.RELEASE_TAG || versions.releaseTag
  const release = await validateReleaseSource({
    repoRoot: root,
    releaseTag,
    sourceSha,
    requireClean,
    requireTagRef,
  })
  if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
    throw new Error('NODE_AUTH_TOKEN is required to publish packages.')
  }

  run('bun', ['run', 'build:package'], root)
  await validateReleaseSource({
    repoRoot: root,
    releaseTag,
    sourceSha,
    requireClean,
    requireTagRef,
  })
  const packageDirectory = path.join(root, 'packages/workbench')
  const temporary = await mkdtemp(path.join(tmpdir(), 'velaros-workbench-package-'))
  const packedTarball = await packUniqueTarball({
    packageDirectory,
    outputDirectory: path.join(temporary, 'pack'),
  })
  const stageDirectory = path.join(root, 'release-stage/package')
  await rm(stageDirectory, { force: true, recursive: true })
  await mkdir(stageDirectory, { recursive: true })
  const tarball = path.join(stageDirectory, path.basename(packedTarball))
  await cp(packedTarball, tarball, { errorOnExist: true, force: false })
  const manifest = await createPackageReleaseManifest({
    tarball,
    packageManifest: release.packageManifest,
    sourceSha,
    releaseTag,
  })
  const manifestFile = path.join(stageDirectory, 'package-release.json')
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await validatePackageReleaseManifest({
    tarball,
    manifest,
    packageManifest: release.packageManifest,
    sourceSha,
    releaseTag,
  })

  const publishArgs = [
    'publish',
    tarball,
    '--registry',
    registry,
    '--access',
    'restricted',
    '--ignore-scripts',
  ]
  if (dryRun) publishArgs.push('--dry-run')
  run('npm', publishArgs, root)
  console.info(
    `${dryRun ? 'Verified' : 'Published'} ${manifest.name}@${manifest.version} `
    + `from ${manifest.fileName} (${manifest.sha256}).`
  )
}

function run(command, args, cwd) {
  const executable = platformExecutable(command)
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    shell: needsCommandShell(command),
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    const reason = result.error?.message || `exit code ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed with ${reason}.`)
  }
}

function runCapture(command, args, cwd) {
  const executable = platformExecutable(command)
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: needsCommandShell(command),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const details = result.error?.message || result.stderr || result.stdout || 'unknown error'
    throw new Error(
      `${command} ${args.join(' ')} failed: ${details.trim()}`
    )
  }
  return result.stdout.trim()
}

function platformExecutable(command) {
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
}

function needsCommandShell(command) {
  return process.platform === 'win32' && command === 'npm'
}

function gitHead(repoRoot) {
  return runCapture('git', ['rev-parse', 'HEAD'], repoRoot)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
