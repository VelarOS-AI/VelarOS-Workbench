import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { execa } from 'execa'

import type {
  WorkbenchGetCodeGraphRequest,
  WorkbenchGetCodeGraphResult,
  WorkbenchProjectAiCodeIndexDiagnostics,
} from '../../shared/contracts'
import type { WorkbenchCodeGraphResourceStatus } from '../../shared/workbenchWorkspace'

import { resolveVelarOSSharedResourcesRoot } from './VelarOSSharedResourceStore'

interface CodeGraphLaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
  packageRoot: string
  version: string
}

interface CodeGraphFileRecord {
  path: string
  language: string
}

interface CodeGraphProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

type CodeGraphProcessRunner = (
  launch: CodeGraphLaunchSpec,
  args: readonly string[],
  cwd: string
) => Promise<CodeGraphProcessResult>

interface WorkbenchCodeGraphResourceOptions {
  sharedResourcesRoot?: string
  platform?: NodeJS.Platform
  arch?: string
  runProcess?: CodeGraphProcessRunner
}

const SourceExtensions = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.mjs',
  '.cts',
  '.cjs',
  '.json',
] as const

const ImportSpecifierPattern =
  /(?:\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/gu

class WorkbenchCodeGraphResource {
  private readonly sharedResourcesRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly runProcess: CodeGraphProcessRunner

  public constructor(options: WorkbenchCodeGraphResourceOptions = {}) {
    this.sharedResourcesRoot =
      options.sharedResourcesRoot ?? resolveVelarOSSharedResourcesRoot()
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.runProcess = options.runProcess ?? runCodeGraphProcess
  }

  public describe(): WorkbenchCodeGraphResourceStatus {
    const launch = this.resolveLaunch()
    return {
      available: !!launch,
      version: launch?.version ?? null,
      packageRoot: launch?.packageRoot ?? null,
      sharedResourcesRoot: this.sharedResourcesRoot,
    }
  }

  public async indexProject(
    projectRoot: string
  ): Promise<WorkbenchProjectAiCodeIndexDiagnostics> {
    const root = resolve(projectRoot)
    const launch = this.resolveLaunch()
    if (!launch) return this.unavailableDiagnostics()

    const indexed = await this.runProcess(launch, ['index', '--quiet'], root)
    if (indexed.exitCode !== 0) {
      const message = processErrorMessage(indexed)
      if (!message.toLowerCase().includes('not initialized')) return this.failedDiagnostics(launch, message)
      const initialized = await this.runProcess(launch, ['init', '-i'], root)
      if (initialized.exitCode !== 0) return this.failedDiagnostics(launch, processErrorMessage(initialized))
    }

    return this.readDiagnostics(root, launch)
  }

  public async getGraph(input: WorkbenchGetCodeGraphRequest): Promise<WorkbenchGetCodeGraphResult> {
    const root = resolve(input.projectRoot)
    const launch = this.resolveLaunch()
    if (!launch) return emptyGraph(input)

    const filesResult = await this.runProcess(launch, ['files', '-p', root, '--json'], root)
    if (filesResult.exitCode !== 0) return emptyGraph(input)

    const files = parseCodeGraphFiles(root, filesResult.stdout).slice(0, 500)
    const graph = await buildFileGraph(root, files)
    const maxNodes = Math.max(1, Math.min(input.maxNodes ?? 120, 500))
    const selection = input.mode === 'local'
      ? selectLocalPaths(graph, normalizeProjectPath(root, input.centerPath ?? ''), input.depth ?? 2, maxNodes)
      : {
          paths: graph.paths.slice(0, maxNodes),
          truncated: graph.paths.length > maxNodes,
        }
    const included = new Set(selection.paths)

    return {
      projectRoot: input.projectRoot,
      mode: input.mode,
      nodes: selection.paths.map((path) => {
        const file = graph.filesByPath.get(path)
        return {
          id: `file:${path}`,
          label: basename(path),
          path,
          language: file?.language ?? languageFromPath(path),
          kind: 'file',
        }
      }),
      edges: graph.edges
        .filter((edge) => included.has(edge.from) && included.has(edge.to))
        .map((edge) => ({ ...edge, kind: 'imports' })),
      truncated: selection.truncated,
    }
  }

  private resolveLaunch(): CodeGraphLaunchSpec | null {
    const packageName = `@colbymchenry/codegraph-${this.platform}-${this.arch}`
    const packageRoot = join(this.sharedResourcesRoot, 'codegraph', packageName)
    if (!existsSync(join(packageRoot, 'package.json'))) return null

    const version = readPackageVersion(packageRoot)
    const env = { ...process.env, CODEGRAPH_NO_DOWNLOAD: '1' } as Record<string, string>
    if (this.platform === 'win32') {
      const nodeExe = join(packageRoot, 'node.exe')
      const entry = join(packageRoot, 'lib', 'dist', 'bin', 'codegraph.js')
      if (!existsSync(nodeExe) || !existsSync(entry)) return null
      return {
        command: nodeExe,
        args: ['--liftoff-only', entry],
        env,
        packageRoot,
        version,
      }
    }

    const launcher = join(packageRoot, 'bin', 'codegraph')
    if (!existsSync(launcher)) return null
    return { command: launcher, args: [], env, packageRoot, version }
  }

  private async readDiagnostics(
    projectRoot: string,
    launch: CodeGraphLaunchSpec
  ): Promise<WorkbenchProjectAiCodeIndexDiagnostics> {
    const result = await this.runProcess(launch, ['status', '--json'], projectRoot)
    if (result.exitCode !== 0) return this.failedDiagnostics(launch, processErrorMessage(result))

    const status = parseJsonRecord(result.stdout)
    const pending = asRecord(status?.['pendingChanges'])
    return {
      providerId: 'codegraph',
      providerLabel: 'CodeGraph',
      version: launch.version,
      initialized: readBoolean(status, 'initialized') ?? readNumber(status, 'nodeCount') > 0,
      indexing: false,
      watching: false,
      fileCount: readNumber(status, 'fileCount'),
      nodeCount: readNumber(status, 'nodeCount'),
      edgeCount: readNumber(status, 'edgeCount'),
      frameworks: readStringArray(status, 'frameworks'),
      backend: readString(status, 'backend'),
      journalMode: readString(status, 'journalMode'),
      pendingFileCount:
        readNumber(pending, 'modified') + readNumber(pending, 'added') + readNumber(pending, 'deleted'),
      lastError: null,
    }
  }

  private unavailableDiagnostics(): WorkbenchProjectAiCodeIndexDiagnostics {
    return {
      providerId: 'codegraph',
      providerLabel: 'CodeGraph',
      version: null,
      initialized: false,
      indexing: false,
      watching: false,
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      frameworks: [],
      backend: null,
      journalMode: null,
      pendingFileCount: 0,
      lastError: null,
      skipped: true,
    }
  }

  private failedDiagnostics(
    launch: CodeGraphLaunchSpec,
    message: string
  ): WorkbenchProjectAiCodeIndexDiagnostics {
    return {
      ...this.unavailableDiagnostics(),
      version: launch.version,
      lastError: message,
      skipped: false,
    }
  }
}

async function runCodeGraphProcess(
  launch: CodeGraphLaunchSpec,
  args: readonly string[],
  cwd: string
): Promise<CodeGraphProcessResult> {
  const result = await execa(launch.command, [...launch.args, ...args], {
    cwd,
    env: launch.env,
    reject: false,
    timeout: 300_000,
  })
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function readPackageVersion(packageRoot: string): string {
  try {
    const packageJson = JSON.parse(
      requireTextFile(join(packageRoot, 'package.json'))
    ) as { version?: unknown }
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function requireTextFile(path: string): string {
  // Resolver runs synchronously during UI capability projection; package.json is tiny and local.
  return readFileSync(path, 'utf8')
}

function processErrorMessage(result: CodeGraphProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `CodeGraph exited ${result.exitCode}`
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function readNumber(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : null
}

function readStringArray(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function parseCodeGraphFiles(projectRoot: string, text: string): CodeGraphFileRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry) => {
    const record = asRecord(entry)
    const path = readString(record, 'path')
    if (!path) return []
    const normalized = normalizeProjectPath(projectRoot, path)
    return normalized
      ? [{ path: normalized, language: readString(record, 'language') ?? languageFromPath(path) }]
      : []
  })
}

async function buildFileGraph(projectRoot: string, files: readonly CodeGraphFileRecord[]) {
  const filesByPath = new Map(files.map((file) => [file.path, file]))
  const paths = [...filesByPath.keys()]
  const indexedPaths = new Set(paths)
  const edges: Array<{ from: string; to: string }> = []

  await Promise.all(paths.map(async (path) => {
    const content = await readFile(resolve(projectRoot, path), 'utf8').catch(() => '')
    for (const specifier of extractImportSpecifiers(content)) {
      const target = resolveImportPath(path, specifier, indexedPaths)
      if (target && target !== path) edges.push({ from: path, to: target })
    }
  }))

  return { filesByPath, paths, edges }
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>()
  for (const match of content.matchAll(ImportSpecifierPattern)) {
    const specifier = match[1]?.trim()
    if (specifier?.startsWith('.')) specifiers.add(specifier)
  }
  return [...specifiers]
}

function resolveImportPath(
  importerPath: string,
  specifier: string,
  indexedPaths: ReadonlySet<string>
): string | null {
  const base = join(dirname(importerPath), specifier).replaceAll('\\', '/')
  for (const extension of SourceExtensions) {
    const candidate = `${base}${extension}`.replace(/^\.\//u, '')
    if (indexedPaths.has(candidate)) return candidate
  }
  for (const extension of SourceExtensions.slice(1)) {
    const candidate = join(base, `index${extension}`).replaceAll('\\', '/')
    if (indexedPaths.has(candidate)) return candidate
  }
  return null
}

function normalizeProjectPath(projectRoot: string, value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const absolute = resolve(projectRoot, trimmed)
  const projectRelative = relative(projectRoot, absolute).replaceAll('\\', '/')
  return projectRelative === '..' || projectRelative.startsWith('../') ? '' : projectRelative
}

function languageFromPath(path: string): string {
  return extname(path).slice(1).toLowerCase() || 'unknown'
}

function selectLocalPaths(
  graph: { paths: string[]; edges: Array<{ from: string; to: string }> },
  centerPath: string,
  depth: number,
  maxNodes: number
): { paths: string[]; truncated: boolean } {
  if (!centerPath || !graph.paths.includes(centerPath)) return { paths: [], truncated: false }
  const adjacency = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    const from = adjacency.get(edge.from) ?? new Set<string>()
    const to = adjacency.get(edge.to) ?? new Set<string>()
    from.add(edge.to)
    to.add(edge.from)
    adjacency.set(edge.from, from)
    adjacency.set(edge.to, to)
  }

  const selected = new Set<string>([centerPath])
  let frontier = [centerPath]
  const maxDepth = Math.max(1, Math.min(depth, 8))
  for (let hop = 0; hop < maxDepth && frontier.length > 0 && selected.size < maxNodes; hop++) {
    const next: string[] = []
    for (const path of frontier) {
      for (const neighbor of adjacency.get(path) ?? []) {
        if (selected.has(neighbor)) continue
        selected.add(neighbor)
        next.push(neighbor)
        if (selected.size >= maxNodes) break
      }
      if (selected.size >= maxNodes) break
    }
    frontier = next
  }
  return { paths: [...selected], truncated: selected.size >= maxNodes }
}

function emptyGraph(input: WorkbenchGetCodeGraphRequest): WorkbenchGetCodeGraphResult {
  return {
    projectRoot: input.projectRoot,
    mode: input.mode,
    nodes: [],
    edges: [],
    truncated: false,
  }
}

export {
  type CodeGraphProcessRunner,
  WorkbenchCodeGraphResource,
  type WorkbenchCodeGraphResourceOptions,
  type WorkbenchCodeGraphResourceStatus,
}
