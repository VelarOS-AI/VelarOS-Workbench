#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromScript = createRequire(import.meta.url)
const electronBuilderCli = requireFromScript.resolve('electron-builder/cli.js')
const requireFromElectronBuilder = createRequire(electronBuilderCli)
const { notarize } = requireFromScript('@electron/notarize')
const { JSON_SCHEMA, dump: serializeYaml, load: parseYaml } = requireFromScript('js-yaml')
const { buildBlockMap } = requireFromElectronBuilder(
  'app-builder-lib/out/targets/blockmap/blockmap.js'
)
const defaultMacOutputDirectory = 'artifacts/desktop'

const completeCredentialGroups = [
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_KEYCHAIN_PROFILE'],
]
const publishFlags = new Set(['--publish', '-p'])
const outputDirectoryFlags = [
  '--config.directories.output',
  '-c.directories.output',
]

function hasCompleteNotarizationCredentials(environment) {
  return completeCredentialGroups.some((names) =>
    names.every((name) => Boolean(environment[name]?.trim()))
  )
}

function resolveMacPackagingEnvironment(environment = process.env) {
  const resolved = { ...environment }
  const configuredProfile = environment.APPLE_KEYCHAIN_PROFILE?.trim()
  if (configuredProfile) resolved.APPLE_KEYCHAIN_PROFILE = configuredProfile
  if (!hasCompleteNotarizationCredentials(resolved)) {
    resolved.APPLE_KEYCHAIN_PROFILE = 'velaros-notary'
  }
  return resolved
}

function readCredential(environment, name) {
  const value = environment[name]?.trim()
  return value || undefined
}

function resolveNotarizationCredentials(environment = process.env) {
  const appleId = readCredential(environment, 'APPLE_ID')
  const appleIdPassword = readCredential(environment, 'APPLE_APP_SPECIFIC_PASSWORD')
  const teamId = readCredential(environment, 'APPLE_TEAM_ID')
  if (appleId || appleIdPassword) {
    if (!appleId || !appleIdPassword || !teamId) {
      throw new Error('Apple ID notarization credentials are incomplete')
    }
    return { tool: 'notarytool', appleId, appleIdPassword, teamId }
  }

  const appleApiKey = readCredential(environment, 'APPLE_API_KEY')
  const appleApiKeyId = readCredential(environment, 'APPLE_API_KEY_ID')
  const appleApiIssuer = readCredential(environment, 'APPLE_API_ISSUER')
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
      throw new Error('App Store Connect API notarization credentials are incomplete')
    }
    return { tool: 'notarytool', appleApiKey, appleApiKeyId, appleApiIssuer }
  }

  const keychainProfile =
    readCredential(environment, 'APPLE_KEYCHAIN_PROFILE') ?? 'velaros-notary'
  const keychain = readCredential(environment, 'APPLE_KEYCHAIN')
  return {
    tool: 'notarytool',
    keychainProfile,
    ...(keychain ? { keychain } : {}),
  }
}

function forwardedArguments(args) {
  return args[0] === '--' ? args.slice(1) : [...args]
}

function resolveMacOutputDirectory(
  args = [],
  { rootDirectory = repoRoot, defaultOutput = defaultMacOutputDirectory } = {}
) {
  const forwarded = forwardedArguments(args)
  const configuredOutputs = []

  for (let index = 0; index < forwarded.length; index += 1) {
    const argument = forwarded[index]
    for (const flag of outputDirectoryFlags) {
      if (argument === flag) {
        const value = forwarded[index + 1]?.trim()
        if (!value) throw new Error(`${flag} requires a non-empty output directory`)
        configuredOutputs.push(value)
        index += 1
        break
      }
      if (argument.startsWith(`${flag}=`)) {
        const value = argument.slice(flag.length + 1).trim()
        if (!value) throw new Error(`${flag} requires a non-empty output directory`)
        configuredOutputs.push(value)
        break
      }
    }
  }

  const uniqueOutputs = [...new Set(configuredOutputs)]
  if (uniqueOutputs.length > 1) {
    throw new Error('macOS packaging received conflicting output directory overrides')
  }
  return path.posix.resolve(rootDirectory, uniqueOutputs[0] ?? defaultOutput)
}

function readWorkbenchVersion(readFile = readFileSync) {
  const manifest = JSON.parse(readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('package.json must contain a non-empty version')
  }
  return manifest.version.trim()
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function currentMacDmgNames(fileNames, version) {
  const versionPattern = escapeRegularExpression(version)
  const expectedName = new RegExp(
    `^VelarOS-Workbench-${versionPattern}-mac-(?:arm64|x64|universal)\\.dmg$`,
    'u'
  )
  return fileNames.filter((fileName) => expectedName.test(fileName)).sort()
}

function selectCurrentMacDmg(fileNames, version) {
  const candidates = currentMacDmgNames(fileNames, version)

  if (candidates.length === 0) {
    throw new Error(`No macOS DMG for Workbench ${version} was found`)
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple macOS DMGs for Workbench ${version} were found: ${candidates.join(', ')}`
    )
  }
  return candidates[0]
}

async function snapshotCurrentMacDmgs({
  outputDirectory,
  version,
  allowMissing = false,
  readDirectory = readdir,
  readStat = stat,
}) {
  let entries
  try {
    entries = await readDirectory(outputDirectory, { withFileTypes: true })
  } catch (error) {
    if (allowMissing && error && typeof error === 'object' && error.code === 'ENOENT') {
      return []
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to inspect macOS package output ${outputDirectory}: ${reason}`)
  }

  const fileNames = currentMacDmgNames(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    version
  )
  return Promise.all(
    fileNames.map(async (fileName) => {
      const fileStat = await readStat(path.posix.join(outputDirectory, fileName))
      return {
        fileName,
        signature: [
          fileStat.dev,
          fileStat.ino,
          fileStat.size,
          fileStat.mtimeMs,
          fileStat.ctimeMs,
        ].join(':'),
      }
    })
  )
}

async function discoverCurrentMacDmg({
  outputDirectory,
  version,
  previousArtifacts = [],
  snapshotDmgs = snapshotCurrentMacDmgs,
}) {
  const currentArtifacts = await snapshotDmgs({ outputDirectory, version })
  const previousByName = new Map(
    previousArtifacts.map((artifact) => [artifact.fileName, artifact.signature])
  )
  const generatedNames = currentArtifacts
    .filter((artifact) => previousByName.get(artifact.fileName) !== artifact.signature)
    .map((artifact) => artifact.fileName)
  return path.posix.join(outputDirectory, selectCurrentMacDmg(generatedNames, version))
}

function buildElectronBuilderArgs(args = []) {
  const forwarded = forwardedArguments(args)
  const safeForwarded = []

  for (let index = 0; index < forwarded.length; index += 1) {
    const argument = forwarded[index]
    if (publishFlags.has(argument)) {
      if (forwarded[index + 1] !== 'never') {
        throw new Error('macOS packaging must keep electron-builder publishing disabled')
      }
      index += 1
      continue
    }
    const inlinePublishFlag = [...publishFlags].find((flag) =>
      argument.startsWith(`${flag}=`)
    )
    if (inlinePublishFlag) {
      if (argument.slice(inlinePublishFlag.length + 1) !== 'never') {
        throw new Error('macOS packaging must keep electron-builder publishing disabled')
      }
      continue
    }
    safeForwarded.push(argument)
  }

  return [
    '--config',
    'electron-builder.yml',
    '--mac',
    ...safeForwarded,
    '--publish',
    'never',
  ]
}

async function executeElectronBuilder({ builderArgs, environment }) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [electronBuilderCli, ...builderArgs], {
      cwd: repoRoot,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else {
        rejectRun(
          new Error(`electron-builder ${signal ? `received ${signal}` : `exited with ${code}`}`)
        )
      }
    })
  })
}

async function executeReleaseCommand(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else {
        rejectRun(
          new Error(`${command} ${signal ? `received ${signal}` : `exited with ${code}`}`)
        )
      }
    })
  })
}

async function verifySignedDmg(dmgPath, execute = executeReleaseCommand) {
  await execute('codesign', ['--verify', '--verbose=2', dmgPath])
}

async function verifyNotarizedDmg(dmgPath, execute = executeReleaseCommand) {
  await execute('xcrun', ['stapler', 'validate', dmgPath])
  await execute('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    dmgPath,
  ])
}

async function sha512File(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('base64')
}

function locateDmgUpdateRecord(metadata, metadataPath, dmgName) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${path.basename(metadataPath)} must contain a YAML object`)
  }
  if (!Array.isArray(metadata.files)) {
    throw new Error(`${path.basename(metadataPath)} must contain an update files array`)
  }
  const matches = metadata.files.filter(
    (entry) => entry && typeof entry === 'object' && entry.url === dmgName
  )
  if (matches.length !== 1) {
    throw new Error(
      `${path.basename(metadataPath)} must contain exactly one update entry for ${dmgName}`
    )
  }
  return matches[0]
}

async function verifyDmgUpdateMetadata({
  dmgPath,
  metadataPath,
  blockmapPath,
  expectedSize,
  expectedSha512,
}) {
  const [dmgStat, blockmapStat, actualSha512, metadataBody] = await Promise.all([
    stat(dmgPath),
    stat(blockmapPath),
    sha512File(dmgPath),
    readFile(metadataPath, 'utf8'),
  ])
  if (!blockmapStat.isFile() || blockmapStat.size === 0) {
    throw new Error(`${path.basename(blockmapPath)} must be a non-empty blockmap`)
  }
  if (dmgStat.size !== expectedSize || actualSha512 !== expectedSha512) {
    throw new Error('Finalized DMG changed while its update metadata was being written')
  }

  const metadata = parseYaml(metadataBody, { schema: JSON_SCHEMA })
  const dmgName = path.basename(dmgPath)
  const record = locateDmgUpdateRecord(metadata, metadataPath, dmgName)
  if (record.size !== dmgStat.size || record.sha512 !== actualSha512) {
    throw new Error(`${path.basename(metadataPath)} does not match the finalized DMG`)
  }
  if (
    metadata.path === dmgName &&
    (metadata.size !== undefined && metadata.size !== dmgStat.size ||
      metadata.sha512 !== actualSha512)
  ) {
    throw new Error(`${path.basename(metadataPath)} primary artifact does not match the finalized DMG`)
  }
}

async function finalizeDmgUpdateMetadata(
  dmgPath,
  {
    buildBlockMapFile = buildBlockMap,
    metadataFileName = 'latest-mac.yml',
  } = {}
) {
  const outputDirectory = path.dirname(dmgPath)
  const dmgName = path.basename(dmgPath)
  const metadataPath = path.join(outputDirectory, metadataFileName)
  const blockmapPath = `${dmgPath}.blockmap`
  const temporarySuffix = `${process.pid}-${randomUUID()}`
  const temporaryBlockmapPath = `${blockmapPath}.tmp-${temporarySuffix}`
  const temporaryMetadataPath = `${metadataPath}.tmp-${temporarySuffix}`

  try {
    const updateInfo = await buildBlockMapFile(dmgPath, 'gzip', temporaryBlockmapPath)
    if (
      !updateInfo ||
      !Number.isSafeInteger(updateInfo.size) ||
      updateInfo.size <= 0 ||
      typeof updateInfo.sha512 !== 'string' ||
      !updateInfo.sha512
    ) {
      throw new Error(`Unable to build update metadata for ${dmgName}`)
    }

    const metadata = parseYaml(await readFile(metadataPath, 'utf8'), {
      schema: JSON_SCHEMA,
    })
    const record = locateDmgUpdateRecord(metadata, metadataPath, dmgName)
    record.size = updateInfo.size
    record.sha512 = updateInfo.sha512
    if (metadata.path === dmgName) {
      metadata.size = updateInfo.size
      metadata.sha512 = updateInfo.sha512
    }

    await writeFile(
      temporaryMetadataPath,
      serializeYaml(metadata, {
        schema: JSON_SCHEMA,
        lineWidth: -1,
        noCompatMode: true,
        noRefs: true,
      }),
      { encoding: 'utf8', flag: 'wx' }
    )
    await rename(temporaryBlockmapPath, blockmapPath)
    await rename(temporaryMetadataPath, metadataPath)
    await verifyDmgUpdateMetadata({
      dmgPath,
      metadataPath,
      blockmapPath,
      expectedSize: updateInfo.size,
      expectedSha512: updateInfo.sha512,
    })
    return {
      blockmapPath,
      metadataPath,
      size: updateInfo.size,
      sha512: updateInfo.sha512,
    }
  } finally {
    await Promise.all([
      rm(temporaryBlockmapPath, { force: true }),
      rm(temporaryMetadataPath, { force: true }),
    ])
  }
}

async function runMacPackage({
  args = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  version = readWorkbenchVersion(),
  runBuilder = executeElectronBuilder,
  snapshotDmgs = snapshotCurrentMacDmgs,
  discoverDmg = discoverCurrentMacDmg,
  notarizeDmg = notarize,
  verifyDmgSignature = verifySignedDmg,
  verifyDmgNotarization = verifyNotarizedDmg,
  finalizeDmgMetadata = finalizeDmgUpdateMetadata,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error(`macOS packaging requires darwin; current platform is ${platform}`)
  }
  const builderArgs = buildElectronBuilderArgs(args)
  const packagingEnvironment = resolveMacPackagingEnvironment(environment)
  const credentials = resolveNotarizationCredentials(packagingEnvironment)
  const outputDirectory = resolveMacOutputDirectory(args)
  const previousArtifacts = await snapshotDmgs({
    outputDirectory,
    version,
    allowMissing: true,
  })

  await runBuilder({ builderArgs, environment: packagingEnvironment })
  const dmgPath = await discoverDmg({ outputDirectory, version, previousArtifacts })
  await verifyDmgSignature(dmgPath)
  console.info(`Notarizing macOS disk image: ${dmgPath}`)
  await notarizeDmg({
    appPath: dmgPath,
    ...credentials,
  })
  await verifyDmgNotarization(dmgPath)
  await finalizeDmgMetadata(dmgPath)
  console.info(`Notarized and stapled macOS disk image: ${dmgPath}`)

  return { dmgPath, outputDirectory, version }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await runMacPackage()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export {
  buildElectronBuilderArgs,
  discoverCurrentMacDmg,
  finalizeDmgUpdateMetadata,
  hasCompleteNotarizationCredentials,
  resolveMacOutputDirectory,
  resolveMacPackagingEnvironment,
  resolveNotarizationCredentials,
  runMacPackage,
  selectCurrentMacDmg,
  snapshotCurrentMacDmgs,
  verifyNotarizedDmg,
  verifySignedDmg,
}
