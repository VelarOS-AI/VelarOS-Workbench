#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromScript = createRequire(import.meta.url)
const electronBuilderCli = requireFromScript.resolve('electron-builder/cli.js')
const { notarize } = requireFromScript('@electron/notarize')
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
  return path.resolve(rootDirectory, uniqueOutputs[0] ?? defaultOutput)
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
      const fileStat = await readStat(path.join(outputDirectory, fileName))
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
  return path.join(outputDirectory, selectCurrentMacDmg(generatedNames, version))
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

async function runMacPackage({
  args = process.argv.slice(2),
  environment = process.env,
  platform = process.platform,
  version = readWorkbenchVersion(),
  runBuilder = executeElectronBuilder,
  snapshotDmgs = snapshotCurrentMacDmgs,
  discoverDmg = discoverCurrentMacDmg,
  notarizeDmg = notarize,
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
  console.info(`Notarizing macOS disk image: ${dmgPath}`)
  await notarizeDmg({
    appPath: dmgPath,
    ...credentials,
  })
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
  hasCompleteNotarizationCredentials,
  resolveMacOutputDirectory,
  resolveMacPackagingEnvironment,
  resolveNotarizationCredentials,
  runMacPackage,
  selectCurrentMacDmg,
  snapshotCurrentMacDmgs,
}
