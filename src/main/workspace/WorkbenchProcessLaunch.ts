import { type ChildProcess,spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, type FileHandle,open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import { AppError, createAbortError } from '@velaros-ai/velaros/core/error'
import { currentPlatform } from '@velaros-ai/velaros/core/platform'

import type { WorkbenchNodeArguments, WorkbenchNodePackageBinTarget, WorkbenchProcessTarget } from '../../shared/contracts/workbench'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import { getRelativePathInsideRoot } from './PathContainmentHelper'
import type { PathResolver } from './PathResolver'

export interface WorkbenchCliQuery {
  readonly settled: Promise<void>
  readonly closed: Promise<void>
  stop(): void
  diagnostics(): Record<string, unknown>
}

export interface WorkbenchProcessContext {
  projectRoot: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  pathResolver: PathResolver
  registerCliQuery(query: WorkbenchCliQuery): void
}

export interface WorkbenchResolvedProcess {
  file: string
  argv: string[]
  env?: NodeJS.ProcessEnv
  windowsVerbatimArguments?: boolean
}

const PackageNamePattern = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u
const PackageManagerPrograms = new Set(['bun', 'bunx', 'npm', 'npx', 'pnpm', 'yarn'])
const LauncherMaxBytes = 64 * 1024
const CliQueryMaxBytes = 64 * 1024
const CliQueryTimeoutMs = 5_000
const CliQueryTerminationMs = 1_000

function isString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  for (const item of value) if (!isString(item)) return false
  return true
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

/** IPC validation preserves literal arguments and the authored shell suffix byte for byte. */
export function readWorkbenchProcessTarget(value: unknown): Nullable<WorkbenchProcessTarget> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const target = value as Record<string, unknown>
  if (!Object.hasOwn(target, 'kind')) return null

  if (target.kind === 'package-manager') {
    if (
      !hasOnlyKeys(target, ['kind', 'program', 'argv']) ||
      !Object.hasOwn(target, 'program') ||
      !Object.hasOwn(target, 'argv') ||
      !isString(target.program) ||
      !PackageManagerPrograms.has(target.program) ||
      !isStringArray(target.argv)
    ) return null
    return {
      kind: 'package-manager',
      program: target.program as Extract<WorkbenchProcessTarget, { kind: 'package-manager' }>['program'],
      argv: [...target.argv],
    }
  }

  if (target.kind === 'python-script') {
    if (
      !hasOnlyKeys(target, ['kind', 'script', 'argv']) ||
      !Object.hasOwn(target, 'script') ||
      !Object.hasOwn(target, 'argv') ||
      !isString(target.script) ||
      target.script.length === 0 ||
      !isStringArray(target.argv)
    ) return null
    return { kind: 'python-script', script: target.script, argv: [...target.argv] }
  }

  if (target.kind !== 'node-script' && target.kind !== 'node-package-bin') return null
  const hasArgv = Object.hasOwn(target, 'argv')
  const hasArgs = Object.hasOwn(target, 'args')
  if (hasArgv === hasArgs) return null
  if (hasArgv ? !isStringArray(target.argv) : !isString(target.args)) return null
  const argumentsValue: WorkbenchNodeArguments = hasArgv
    ? { argv: [...(target.argv as string[])] }
    : { args: target.args as string }

  if (target.kind === 'node-script') {
    if (
      !hasOnlyKeys(target, ['kind', 'script', 'args', 'argv']) ||
      !Object.hasOwn(target, 'script') ||
      !isString(target.script) ||
      target.script.length === 0
    ) return null
    return { kind: 'node-script', script: target.script, ...argumentsValue }
  }

  if (
    !hasOnlyKeys(target, ['kind', 'packageName', 'binName', 'args', 'argv']) ||
    !Object.hasOwn(target, 'packageName') ||
    !isString(target.packageName) ||
    !PackageNamePattern.test(target.packageName) ||
    (Object.hasOwn(target, 'binName') && (!isString(target.binName) || target.binName.length === 0))
  ) return null
  const result: WorkbenchNodePackageBinTarget = {
    kind: 'node-package-bin',
    packageName: target.packageName,
    ...argumentsValue,
  }
  if (Object.hasOwn(target, 'binName')) result.binName = target.binName as string
  return result
}

export async function resolveWorkbenchProcessLaunch(
  target: WorkbenchProcessTarget,
  context: WorkbenchProcessContext,
  options?: { nodeArgvPrefix?: readonly string[] }
): Promise<WorkbenchResolvedProcess> {
  context.signal.throwIfAborted()
  const checked = readWorkbenchProcessTarget(target)
  const nodeArgvPrefix = options?.nodeArgvPrefix ?? []
  if (!checked || !isStringArray(nodeArgvPrefix)) {
    throw new AppError('VALIDATION', workbenchMainText('process.invalidTarget'))
  }

  if (checked.kind === 'package-manager') {
    const file = await findProgram(checked.program, context)
    const launcher = await resolveProgramLauncher(file, checked.program, context)
    context.signal.throwIfAborted()
    return { ...launcher, argv: [...launcher.argv, ...checked.argv] }
  }

  const script = checked.kind === 'node-package-bin'
    ? await resolveWorkbenchPackageBin(
        context.cwd,
        checked.packageName,
        checked.binName ?? checked.packageName.split('/').at(-1)!
      )
    : await resolveProjectScript(checked.script, context)
  context.signal.throwIfAborted()
  if (script === null) {
    const packageName = checked.kind === 'node-package-bin' ? checked.packageName : ''
    throw new AppError('NOT_FOUND', workbenchMainText('process.packageBinMissing', { package: packageName }))
  }

  if (checked.kind === 'python-script') {
    const file = await findProgram('python3', context)
    await requireNativeExecutable(file, 'python3')
    context.signal.throwIfAborted()
    return { file, argv: [script, ...checked.argv] }
  }

  const node = await resolveNodeExecutable(context)
  context.signal.throwIfAborted()
  const prefix = [...nodeArgvPrefix, script]
  if ('argv' in checked && checked.argv !== undefined) return { file: node, argv: [...prefix, ...checked.argv] }
  return resolveRawNodeLaunch(node, prefix, checked.args!, context.env)
}

async function resolveProjectScript(script: string, context: WorkbenchProcessContext): Promise<string> {
  const lexicalPath = resolve(context.projectRoot, script)
  context.pathResolver.assertAllowedProjectPath(context.projectRoot, lexicalPath, script)
  const file = await realpath(lexicalPath)
  context.pathResolver.assertAllowedProjectPath(context.projectRoot, file, script)
  if (!(await stat(file)).isFile()) {
    throw new AppError('VALIDATION', workbenchMainText('process.scriptNotFile', { path: script }))
  }
  return file
}

function resolveRawNodeLaunch(
  node: string,
  prefix: string[],
  args: string,
  env: NodeJS.ProcessEnv
): WorkbenchResolvedProcess {
  const shellPath = currentPlatform.getPreferredShellPath(env)
  const kind = currentPlatform.getShellKind(shellPath)
  const shellOptions = { env, shellPath, kind }
  const command = [node, ...prefix].map((value) => currentPlatform.quoteShellArg(value, shellOptions)).join(' ')
  const invocation = `${kind === 'powershell' || kind === 'pwsh' ? '& ' : ''}${command} ${args}`
  const spec = currentPlatform.getShellCommandSpec(invocation, shellOptions)
  return { file: spec.file, argv: spec.args, windowsVerbatimArguments: spec.windowsVerbatimArguments }
}

/** Resolve an installed package's declared Node bin, including hoisted and symlinked packages. */
export async function resolveWorkbenchPackageBin(
  startDirectory: string,
  packageName: string,
  binName: string
): Promise<Nullable<string>> {
  if (!PackageNamePattern.test(packageName) || !isString(binName) || binName.length === 0) return null
  for (let directory = resolve(startDirectory); ; directory = dirname(directory)) {
    const packageDirectory = join(directory, 'node_modules', packageName)
    const manifest = await readOptionalFile(join(packageDirectory, 'package.json'))
    if (manifest !== null) {
      let value: unknown
      try {
        value = JSON.parse(manifest)
      } catch {
        // arch-guard:silent-catch-ok An invalid nearest package cannot provide a runnable bin.
        return null
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const { name, bin } = value as { name?: unknown; bin?: unknown }
      const declaredBinName = isString(name)
        ? join('/', basename(name.replace(/\\|:/gu, '/'))).slice(1)
        : null
      const entry = typeof bin === 'string'
        ? binName === declaredBinName ? bin : null
        : bin !== null && typeof bin === 'object' && !Array.isArray(bin) && Object.hasOwn(bin, binName)
          ? (bin as Record<string, unknown>)[binName]
          : null
      if (!isString(entry) || entry.length === 0) return null
      const lexicalBin = resolve(packageDirectory, entry)
      if (getRelativePathInsideRoot(packageDirectory, lexicalBin) === null) return null
      const packageRoot = await realpath(packageDirectory)
      const file = await optionalRealpath(lexicalBin)
      if (file === null || getRelativePathInsideRoot(packageRoot, file) === null) return null
      if (!(await stat(file)).isFile()) return null
      if (!(await isNodeScript(file))) {
        throw new AppError('UNAVAILABLE', workbenchMainText('process.packageBinNotNode', { package: packageName }))
      }
      return file
    }
    if (dirname(directory) === directory) return null
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

async function findProgram(program: string, context: WorkbenchProcessContext): Promise<string> {
  context.signal.throwIfAborted()
  const path = environmentValue(context.env, 'PATH')
  const directories = path === undefined ? [] : path.split(delimiter)
  if (process.platform === 'win32') directories.unshift(context.cwd)
  const candidates = currentPlatform.buildExecutableCandidates(program, {
    ...context.env,
    PATHEXT: environmentValue(context.env, 'PATHEXT'),
  }).filter((candidate) => process.platform !== 'win32' || candidate !== program)
  let denied: unknown
  for (const directory of directories) {
    const unquoted = process.platform === 'win32' && directory.startsWith('"') && directory.endsWith('"')
      ? directory.slice(1, -1)
      : directory
    for (const candidate of candidates) {
      context.signal.throwIfAborted()
      const file = resolve(context.cwd, unquoted, candidate)
      const metadata = await optionalStat(file)
      if (!metadata?.isFile()) continue
      if (process.platform !== 'win32') {
        try {
          await access(file, constants.X_OK)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error
          denied = error
          continue
        }
      }
      return file
    }
  }
  if (denied) throw denied
  throw new AppError('NOT_FOUND', workbenchMainText('process.programMissing', { program }))
}

async function resolveNodeExecutable(context: WorkbenchProcessContext): Promise<string> {
  const file = await findProgram('node', context)
  await requireNativeExecutable(file, 'node')
  return file
}

async function requireNativeExecutable(file: string, program: string): Promise<void> {
  if (!isNativeHeader(await readFileHead(file))) throw unsupportedLauncher(program)
}

async function resolveProgramLauncher(
  file: string,
  program: string,
  context: WorkbenchProcessContext
): Promise<WorkbenchResolvedProcess> {
  context.signal.throwIfAborted()
  const { header, source } = await readLauncher(file, program)
  if (isNativeHeader(header)) return { file, argv: [] }
  if (process.platform !== 'win32') {
    if (readNodeShebang(header) !== null) return { file, argv: [] }
    throw unsupportedLauncher(program)
  }
  if (extname(file).toLowerCase() !== '.cmd') throw unsupportedLauncher(program)
  if (source === null) throw unsupportedLauncher(program)
  if ((program === 'npm' || program === 'npx') && source === npmInstallerShim(program)) return resolveNpmInstaller(file, program, context)
  const shim = readNodeCommandShim(source)
  if (shim === null) throw unsupportedLauncher(program)
  const localNode = await resolveLocalShimNode(file)
  const env = shim.removeJavaScriptExtension === 'always' || localNode === null
    ? withoutJavaScriptPathExtension(context.env)
    : undefined
  const node = localNode ?? await resolveNodeExecutable(env ? { ...context, env } : context)
  const script = resolve(dirname(file), shim.script)
  if (!(await optionalStat(script))?.isFile() || !(await isNodeScript(script))) throw unsupportedLauncher(program)
  return { file: node, argv: [...shim.nodeArgv, script], env }
}

async function readLauncher(file: string, program: string): Promise<{ header: Buffer; source: Nullable<string> }> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(LauncherMaxBytes + 1)
    let length = await fillFileBuffer(handle, buffer, 0, 4_096)
    const header = buffer.subarray(0, length)
    if (isNativeHeader(header) || process.platform !== 'win32' || extname(file).toLowerCase() !== '.cmd') return { header, source: null }
    length = await fillFileBuffer(handle, buffer, length, buffer.length)
    if (length > LauncherMaxBytes) throw unsupportedLauncher(program)
    return { header, source: buffer.subarray(0, length).toString('utf8').replace(/\r\n/gu, '\n').trim() }
  } finally {
    await handle.close()
  }
}

async function fillFileBuffer(handle: FileHandle, buffer: Buffer, offset: number, limit: number): Promise<number> {
  let cursor = offset
  while (cursor < limit) {
    const { bytesRead } = await handle.read(buffer, cursor, limit - cursor, cursor)
    if (bytesRead === 0) break
    cursor += bytesRead
  }
  return cursor
}

function withoutJavaScriptPathExtension(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const derived = { ...env }
  for (const key of Object.keys(derived)) if (key.toUpperCase() === 'PATHEXT') delete derived[key]
  const extensions = (environmentValue(env, 'PATHEXT') ?? '').replace(/;\.JS;/giu, ';')
  if (extensions) derived.PATHEXT = extensions
  return derived
}

/** This is the complete npm installer template, not a guessed neighboring npm installation. */
function npmInstallerShim(program: 'npm' | 'npx'): string {
  const variable = program === 'npm' ? 'NPM' : 'NPX'
  return `:: Created by npm, please don't edit manually.
@ECHO OFF

SETLOCAL

SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" (
  SET "NODE_EXE=node"
)

SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "${variable}_CLI_JS=%~dp0\\node_modules\\npm\\bin\\${program}-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_${variable}_CLI_JS=%%F\\node_modules\\npm\\bin\\${program}-cli.js"
)
IF EXIST "%NPM_PREFIX_${variable}_CLI_JS%" (
  SET "${variable}_CLI_JS=%NPM_PREFIX_${variable}_CLI_JS%"
)

"%NODE_EXE%" "%${variable}_CLI_JS%" %*`
}

async function resolveNpmInstaller(
  shim: string,
  program: 'npm' | 'npx',
  context: WorkbenchProcessContext
): Promise<WorkbenchResolvedProcess> {
  const node = await resolveLocalShimNode(shim) ?? await resolveNodeExecutable(context)
  const prefixScript = join(dirname(shim), 'node_modules', 'npm', 'bin', 'npm-prefix.js')
  if (!(await optionalStat(prefixScript))?.isFile() || !(await isNodeScript(prefixScript))) throw unsupportedLauncher(program)
  const output = await queryCli(node, [prefixScript], program, context)
  const prefix = output.replace(/\r?\n$/u, '')
  if (!isString(prefix) || !isAbsolute(prefix) || /[\r\n]/u.test(prefix)) {
    throw new AppError('UNAVAILABLE', workbenchMainText('process.cliQueryFailed', { program }))
  }
  const redirected = join(prefix, 'node_modules', 'npm', 'bin', `${program}-cli.js`)
  const file = await optionalStat(redirected)
    ? redirected
    : join(dirname(shim), 'node_modules', 'npm', 'bin', `${program}-cli.js`)
  if (!(await optionalStat(file))?.isFile() || !(await isNodeScript(file))) throw unsupportedLauncher(program)
  return { file: node, argv: [file] }
}

async function resolveLocalShimNode(shim: string): Promise<Nullable<string>> {
  const local = join(dirname(shim), 'node.exe')
  if (await optionalStat(local)) {
    await requireNativeExecutable(local, 'node')
    return local
  }
  return null
}

function readNodeCommandShim(source: string): Nullable<{
  script: string
  nodeArgv: string[]
  removeJavaScriptExtension: 'always' | 'without-local-node'
}> {
  const current = /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n\nIF EXIST "%dp0%\\node\.exe" \(\n {2}SET "_prog=%dp0%\\node\.exe"\n\) ELSE \(\n {2}SET "_prog=node"\n\)\n\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;\.JS;=;% & "%_prog%" ([^\n]*?) "%dp0%\\([^"\n]+)" %\*$/iu.exec(source)
  const direct = /^@IF EXIST "%~dp0\\node\.exe" \(\n[ \t]+"%~dp0\\node\.exe" ([^\n]*?) "%~dp0\\([^"\n]+)" %\*\n\) ELSE \(\n[ \t]+@SETLOCAL\n[ \t]+@SET PATHEXT=%PATHEXT:;\.JS;=;%\n[ \t]+node \1 "%~dp0\\\2" %\*\n\)$/iu.exec(source)
  const match = current ?? direct
  if (match === null || /[%!^&|<>\0]/u.test(match[2]!)) return null
  const flags = match[1]!.trim()
  if (flags && !/^[A-Za-z0-9_./:=+,-]+(?:[ \t]+[A-Za-z0-9_./:=+,-]+)*$/u.test(flags)) return null
  return {
    script: match[2]!,
    nodeArgv: flags ? flags.split(/[ \t]+/u) : [],
    removeJavaScriptExtension: current ? 'always' : 'without-local-node',
  }
}

function readNodeShebang(header: Buffer): Nullable<string> {
  const line = header.toString('utf8').split(/\r?\n/u, 1)[0]!
  if (!line.startsWith('#!')) return null
  const words = line.slice(2).trim().split(/[ \t]+/u)
  const interpreter = words[0]!
  if (isAbsolute(interpreter) && basename(interpreter) === 'node') return line
  if (isAbsolute(interpreter) && basename(interpreter) === 'env') {
    const program = words[1] === '-S' ? words[2] : words[1]
    if (program === 'node') return line
  }
  return null
}

async function isNodeScript(file: string): Promise<boolean> {
  const header = await readFileHead(file)
  if (isNativeHeader(header)) return false
  if (header.subarray(0, 2).toString() === '#!') return readNodeShebang(header) !== null
  return ['.js', '.cjs', '.mjs'].includes(extname(file).toLowerCase())
}

function isNativeHeader(header: Buffer): boolean {
  if (header.length < 4) return false
  if (process.platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a
  const magic = header.readUInt32BE(0)
  if (process.platform !== 'darwin') return magic === 0x7f454c46
  return magic === 0xfeedface || magic === 0xfeedfacf ||
    magic === 0xcefaedfe || magic === 0xcffaedfe || magic === 0xcafebabe || magic === 0xbebafeca ||
    magic === 0xcafebabf || magic === 0xbfbafeca
}

async function readFileHead(file: string): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(4_096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function unsupportedLauncher(program: string): AppError {
  return new AppError('UNAVAILABLE', workbenchMainText('process.unsupportedLauncher', { program }))
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function optionalStat(file: string): Promise<Nullable<Awaited<ReturnType<typeof stat>>>> {
  try {
    return await stat(file)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function optionalRealpath(file: string): Promise<Nullable<string>> {
  try {
    return await realpath(file)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function readOptionalFile(file: string): Promise<Nullable<string>> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** Register ownership before spawning; request completion and confirmed resource closure are separate receipts. */
async function queryCli(
  file: string,
  argv: string[],
  program: string,
  context: WorkbenchProcessContext
): Promise<string> {
  context.signal.throwIfAborted()
  const query = new CliQuery(program, context)
  try {
    context.registerCliQuery(query)
  } catch (error) {
    query.rejectBeforeSpawn(error)
    return query.result
  }
  query.start(file, argv, context.env)
  return query.result
}

class CliQuery implements WorkbenchCliQuery {
  readonly settled: Promise<void>
  readonly closed: Promise<void>
  readonly result: Promise<string>
  private readonly id = randomUUID()
  private readonly deadline = Date.now() + CliQueryTimeoutMs
  private readonly chunks: Buffer[] = []
  private readonly failures: unknown[] = []
  private readonly cleanupErrors: unknown[] = []
  private readonly killAttempts: Array<Record<string, unknown>> = []
  private readonly stopTimer: ReturnType<typeof setTimeout>
  private readonly deadlineTimer: ReturnType<typeof setTimeout>
  private resolveSettled!: () => void
  private resolveClosed!: () => void
  private resolveResult!: (output: string) => void
  private rejectResult!: (error: unknown) => void
  private child?: ChildProcess
  private terminationChild?: ChildProcess
  private noChild = false
  private queryClosed = false
  private terminationClosed = false
  private closedConfirmed = false
  private requestSettled = false
  private terminationStarted = false
  private bytes = 0
  private exitCode: Nullable<number> = null
  private exitSignal: Nullable<NodeJS.Signals> = null
  private terminationExitCode: Nullable<number> = null
  private terminationExitSignal: Nullable<NodeJS.Signals> = null
  private readonly onAbort = (): void => { this.stop() }

  constructor(private readonly program: string, private readonly context: WorkbenchProcessContext) {
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve })
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve })
    this.result = new Promise((resolve, reject) => { this.resolveResult = resolve; this.rejectResult = reject })
    this.stopTimer = setTimeout(() => {
      this.failures.push(this.timeoutError())
      this.beginTermination()
    }, Math.max(0, this.deadline - CliQueryTerminationMs - Date.now()))
    this.deadlineTimer = setTimeout(() => {
      if (this.failures.length === 0) this.failures.push(this.timeoutError())
      this.beginTermination()
      this.forceKillOwnedProcesses()
      this.finishRequest()
    }, Math.max(0, this.deadline - Date.now()))
    context.signal.addEventListener('abort', this.onAbort, { once: true })
  }

  public start(file: string, argv: string[], env: NodeJS.ProcessEnv): void {
    if (this.requestSettled) return
    if (this.context.signal.aborted) { this.stop(); return }
    if (Date.now() >= this.deadline - CliQueryTerminationMs) {
      this.rejectBeforeSpawn(this.timeoutError())
      return
    }
    let child: ChildProcess
    try {
      child = spawn(file, argv, {
        cwd: this.context.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.rejectBeforeSpawn(this.queryError(error))
      return
    }
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk, true))
    child.stderr?.on('data', (chunk: Buffer) => this.consume(chunk, false))
    child.on('error', (error: unknown) => {
      this.failures.push(this.queryError(error))
      this.beginTermination()
    })
    child.once('close', (code, signal) => {
      this.queryClosed = true
      this.exitCode = code
      this.exitSignal = signal
      if ((code !== 0 || signal !== null) && this.failures.length === 0) this.failures.push(this.queryError())
      this.confirmClosed()
    })
  }

  public rejectBeforeSpawn(error: unknown): void {
    this.failures.push(error)
    this.noChild = true
    this.confirmClosed()
  }

  public stop(): void {
    if (this.closedConfirmed) return
    if (this.failures.length === 0) this.failures.push(this.context.signal.aborted ? this.context.signal.reason : createAbortError())
    this.beginTermination()
    if (this.requestSettled) this.forceKillOwnedProcesses()
  }

  public diagnostics(): Record<string, unknown> {
    return {
      id: this.id,
      pid: this.child?.pid ?? null,
      program: this.program,
      cwd: this.context.cwd,
      projectRoot: this.context.projectRoot,
      deadline: this.deadline,
      settled: this.requestSettled,
      closed: this.closedConfirmed,
      queryClosed: this.noChild || this.queryClosed,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      errors: this.failures.map((error) => AppError.from(error).toJSON()),
      termination: {
        started: this.terminationStarted,
        pid: this.terminationChild?.pid ?? null,
        closed: !this.terminationChild || this.terminationClosed,
        exitCode: this.terminationExitCode,
        signal: this.terminationExitSignal,
        attempts: [...this.killAttempts],
        errors: this.cleanupErrors.map((error) => AppError.from(error).toJSON()),
      },
    }
  }

  private consume(chunk: Buffer, stdout: boolean): void {
    this.bytes += chunk.length
    if (this.bytes > CliQueryMaxBytes) {
      if (!this.failures.some((error) => error instanceof AppError && error.code === 'LIMIT')) {
        this.failures.push(new AppError('LIMIT', workbenchMainText('process.cliQueryTooLarge')))
      }
      this.beginTermination()
    } else if (stdout && !this.requestSettled) this.chunks.push(chunk)
  }

  private beginTermination(): void {
    if (this.terminationStarted || this.closedConfirmed) return
    this.terminationStarted = true
    if (!this.child) {
      this.noChild = true
      this.confirmClosed()
      return
    }
    if (this.queryClosed) { this.confirmClosed(); return }
    if (process.platform !== 'win32') {
      this.killQueryGroup()
      return
    }
    if (!this.child.pid) return
    if (Date.now() >= this.deadline) {
      this.killChild(this.child, this.queryClosed)
      return
    }
    try {
      const termination = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.terminationChild = termination
      termination.stdout?.resume()
      termination.stderr?.resume()
      termination.on('error', (error: unknown) => {
        this.cleanupErrors.push(error)
        this.killChild(this.child, this.queryClosed)
      })
      termination.once('close', (code, signal) => {
        this.terminationClosed = true
        this.terminationExitCode = code
        this.terminationExitSignal = signal
        if (code !== 0 || signal !== null) {
          this.cleanupErrors.push(this.queryError({ terminationExitCode: code, terminationSignal: signal }))
          this.killChild(this.child, this.queryClosed)
        }
        this.confirmClosed()
      })
    } catch (error) {
      this.cleanupErrors.push(error)
      this.killChild(this.child, this.queryClosed)
    }
  }

  private forceKillOwnedProcesses(): void {
    if (!this.queryClosed && this.child) {
      if (process.platform === 'win32') this.killChild(this.child, false)
      else this.killQueryGroup()
    }
    this.killChild(this.terminationChild, this.terminationClosed)
  }

  private killQueryGroup(): void {
    if (!this.child?.pid || this.queryClosed) return
    try {
      process.kill(-this.child.pid, 'SIGKILL')
      this.killAttempts.push({ target: 'query-group', pid: this.child.pid, accepted: true, at: Date.now() })
    } catch (error) {
      this.killAttempts.push({ target: 'query-group', pid: this.child.pid, error: AppError.from(error).toJSON(), at: Date.now() })
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.cleanupErrors.push(error)
      this.killChild(this.child, this.queryClosed)
    }
  }

  private killChild(child: ChildProcess | undefined, closed: boolean): void {
    if (!child || closed) return
    try {
      const accepted = child.kill('SIGKILL')
      this.killAttempts.push({ target: child === this.child ? 'query' : 'termination', pid: child.pid ?? null, accepted, at: Date.now() })
    } catch (error) {
      this.killAttempts.push({ target: child === this.child ? 'query' : 'termination', pid: child.pid ?? null, error: AppError.from(error).toJSON(), at: Date.now() })
      this.cleanupErrors.push(error)
    }
  }

  private confirmClosed(): void {
    if ((!this.noChild && !this.queryClosed) || (this.terminationChild && !this.terminationClosed)) return
    this.closedConfirmed = true
    this.resolveClosed()
    this.finishRequest()
  }

  private finishRequest(): void {
    if (this.requestSettled) return
    this.requestSettled = true
    clearTimeout(this.stopTimer)
    clearTimeout(this.deadlineTimer)
    this.context.signal.removeEventListener('abort', this.onAbort)
    const failures = [...this.failures, ...this.cleanupErrors]
    if (failures.length === 0 && !this.context.signal.aborted && Date.now() >= this.deadline) failures.push(this.timeoutError())
    if (this.context.signal.aborted && !failures.includes(this.context.signal.reason)) failures.push(this.context.signal.reason)
    if (!this.closedConfirmed) failures.push(this.timeoutError())
    if (failures.length === 0) this.resolveResult(Buffer.concat(this.chunks).toString('utf8'))
    else if (failures.length === 1) this.rejectResult(failures[0])
    else {
      const primary = this.context.signal.aborted ? this.context.signal.reason : failures[0]
      const code = this.context.signal.aborted ? 'CANCELLED' : AppError.from(primary).code
      this.rejectResult(new AppError(code, AppError.getMessage(primary), new AggregateError(failures, 'CLI query and cleanup failed'), this.diagnostics()))
    }
    this.chunks.length = 0
    this.resolveSettled()
  }

  private timeoutError(): AppError {
    return new AppError('TIMEOUT', workbenchMainText('process.cliQueryTimedOut'), undefined, this.diagnostics())
  }

  private queryError(cause?: unknown): AppError {
    return new AppError('UNAVAILABLE', workbenchMainText('process.cliQueryFailed', { program: this.program }), cause)
  }
}
