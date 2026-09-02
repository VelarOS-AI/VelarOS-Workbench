#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromScript = createRequire(import.meta.url)
const electronBuilderCli = requireFromScript.resolve('electron-builder/cli.js')

const completeCredentialGroups = [
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_KEYCHAIN_PROFILE'],
]
const publishFlags = new Set(['--publish', '-p'])

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

function buildElectronBuilderArgs(args = []) {
  const forwarded = args[0] === '--' ? args.slice(1) : [...args]
  const publishIndex = forwarded.findIndex((argument) => publishFlags.has(argument))
  if (publishIndex >= 0) {
    if (forwarded[publishIndex + 1] !== 'never') {
      throw new Error('macOS packaging must keep electron-builder publishing disabled')
    }
    return ['--config', 'electron-builder.yml', '--mac', ...forwarded]
  }
  return ['--config', 'electron-builder.yml', '--mac', ...forwarded, '--publish', 'never']
}

async function runMacPackage({ args = process.argv.slice(2), environment = process.env } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`macOS packaging requires darwin; current platform is ${process.platform}`)
  }
  const builderArgs = buildElectronBuilderArgs(args)
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [electronBuilderCli, ...builderArgs], {
      cwd: repoRoot,
      env: resolveMacPackagingEnvironment(environment),
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
  hasCompleteNotarizationCredentials,
  resolveMacPackagingEnvironment,
  runMacPackage,
}
