import { createHash } from 'node:crypto'
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import * as ts from 'typescript'

import { languageWorkerResourcesPath } from './TypeScriptSdk'

const TypeScriptExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.cts', '.mts', '.cjs', '.mjs'])
const JavaScriptExtensions = new Set(['.js', '.jsx', '.cjs', '.mjs'])
const MaxTypeScriptProjectFiles = 2000
const MaxPackageTypeEntries = 256
const MaxTypeScriptConfigCandidates = 256
const SkippedDirectoryNames = new Set([
  '.data',
  '.git',
  '.idea',
  '.velaros',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

export interface TypeScriptProjectConfig {
  projectRoot: string
  projectDirectory: string
  configPath: Nullable<string>
  compilerOptions: ts.CompilerOptions
  fileNames: string[]
  projectReferences?: readonly ts.ProjectReference[]
  packageJsonPaths: string[]
  /** 编译选项、配置文件、依赖清单的指纹；不含文件清单。 */
  optionsFingerprint: string
  /** 连文件清单一起的指纹。 */
  fingerprint: string
}

interface TypeScriptProjectCacheEntry {
  cacheKey: string
  config: TypeScriptProjectConfig
  diskFiles: Map<string, string>
  packageImportsLoaded: boolean
}

interface PooledTypeScriptProject {
  projectRoot: string
  projectDirectory: string
  /** 最近一次落到这个项目头上的请求文件：要再取这个项目时拿它当请求文件。 */
  requestFileName: string
  /**
   * 不为空时 TypeScript 把它当项目版本：版本没变就不再核对程序是不是最新的。只在一段同步计算当中设上
   * （见 freezeTypeScriptProgramWhile）；平时为空，每次调用照旧核对。
   */
  frozenVersion: string
  compilerOptions: ts.CompilerOptions
  projectReferences?: readonly ts.ProjectReference[]
  diskFiles: Map<string, string>
  liveFiles: Map<string, string>
  fileVersions: Map<string, number>
  overlayPaths: Set<string>
  service: ts.LanguageService
}

const MaxMemoizedProjectConfigs = 256
/**
 * 同时活着的 TypeScript 服务上限。monorepo 里每个包一个 tsconfig，每个服务连同它 import 的兄弟包源码、
 * lib.d.ts 与依赖类型要 200–250MB 堆（VelarOS-Platform 实测），22 个包一路打开就是 4GB——正是语言服务
 * worker 被 V8 OOM 掐死、连带整个应用闪退的原因。最近用过的留着，其余丢掉；重建一个只要一秒左右。
 */
export const MaxPooledTypeScriptProjects = 4
let pooledProjectLimit = MaxPooledTypeScriptProjects

/**
 * 按 worker 的堆上限定同时活着的服务数：每个服务按 700MB 预留（monorepo 里的大包连同兄弟包源码就有这么大），
 * 最少 2 个、最多 6 个。16GB 机器（4GB 堆）5 个，8GB 机器（2GB 堆）2 个。
 */
export function configureTypeScriptProjectPool(heapLimitBytes: number): number {
  const budgeted = Math.floor(heapLimitBytes / (700 * 1024 * 1024))
  pooledProjectLimit = Math.min(6, Math.max(2, budgeted))
  return pooledProjectLimit
}
const projectCache = new Map<string, TypeScriptProjectCacheEntry>()
/** 按最近使用排序：Map 的插入序即 LRU 序，命中时删掉重插到末尾。 */
const pooledProjects = new Map<string, PooledTypeScriptProject>()
/**
 * 所有服务共用一份文档注册表：编译选项相同的服务共享同一份解析好的 SourceFile（lib.d.ts、@types、
 * 被多个包 import 的同一个源文件），不再每个服务各存一份。
 */
let sharedDocumentRegistry: Nullable<ts.DocumentRegistry> = null

function documentRegistry(): ts.DocumentRegistry {
  sharedDocumentRegistry ??= ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames)
  return sharedDocumentRegistry
}
const projectConfigCandidates = new Map<string, TypeScriptProjectConfigCandidate[]>()
/**
 * 按 (项目根, 请求文件) 记住解析好的项目配置。解析一次要找 tsconfig、按 include 全局扫描目录、stat 每个
 * package.json，大项目里要一百多毫秒，而每一次悬浮、补全、诊断都会走到这里。配置文件、package.json 变了整体
 * 清掉（{@link clearTypeScriptProjectCache}）；源文件新建、删除只作废这份记忆（{@link invalidateTypeScriptProjectConfigs}），
 * 下一次请求重新解析并按新清单增删根文件。
 */
const projectConfigMemo = new Map<string, TypeScriptProjectConfig>()

interface TypeScriptProjectConfigCandidate {
  configPath: string
  parsed: ts.ParsedCommandLine
}

function resolveTypeScriptDefaultLibFilePath(
  options: ts.CompilerOptions,
  resourcesPath: Nullable<string> = languageWorkerResourcesPath()
): string {
  if (resourcesPath) {
    const bundledLibDirectory = resolve(resourcesPath, 'typescript', 'lib')
    const bundledDefaultLib = resolve(bundledLibDirectory, ts.getDefaultLibFileName(options))
    if (existsSync(bundledDefaultLib)) return bundledDefaultLib
  }

  return ts.getDefaultLibFilePath(options)
}

function extensionWithDot(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

/**
 * 读磁盘上的源文件。开头的 BOM 去掉（与 TypeScript 自己的 `sys.readFile`、编辑器里的正文一致），否则第一行的
 * 行列会比编辑器里多一格，改名、诊断落到没打开的文件上时就错位了。
 */
function safeReadFile(path: string): Nullable<string> {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const content = readFileSync(path, 'utf8')
    return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  } catch {
    return null
  }
}

/** `childPath` 就是 `parentPath`，或者在它下面。 */
function isPathInside(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath)
  return (
    childRelativePath === '' ||
    (childRelativePath !== '..' &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath))
  )
}

/** TypeScript 的文件名统一使用正斜杠，覆盖层和磁盘缓存必须使用同一份键。 */
export function normalizeTypeScriptFileName(path: string): string {
  return path.replaceAll('\\', '/')
}

/** 同一个文件的斜杠方向与大小写归成一种，用于比较文件身份。 */
function canonicalTypeScriptPath(path: string): string {
  const absolutePath = resolve(path).replaceAll('\\', '/')
  return ts.sys.useCaseSensitiveFileNames ? absolutePath : absolutePath.toLowerCase()
}

function typeScriptPathsEqual(left: string, right: string): boolean {
  return canonicalTypeScriptPath(left) === canonicalTypeScriptPath(right)
}

function findNearestPackageJsonPath(
  projectRoot: string,
  requestAbsolutePath: string
): Nullable<string> {
  let directory = dirname(requestAbsolutePath)

  while (isPathInside(projectRoot, directory)) {
    const packageJsonPath = resolve(directory, 'package.json')
    if (existsSync(packageJsonPath)) return packageJsonPath

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  return null
}

function collectPackageJsonPaths(projectRoot: string, requestAbsolutePath: string): string[] {
  const packageJsonPaths: string[] = []
  const nearestPackageJsonPath = findNearestPackageJsonPath(projectRoot, requestAbsolutePath)
  const rootPackageJsonPath = resolve(projectRoot, 'package.json')

  if (nearestPackageJsonPath) packageJsonPaths.push(nearestPackageJsonPath)
  if (existsSync(rootPackageJsonPath) && !packageJsonPaths.includes(rootPackageJsonPath)) {
    packageJsonPaths.push(rootPackageJsonPath)
  }

  return packageJsonPaths
}

function readPackageModuleType(
  packageJsonPath: string | undefined
): Nullable<'module' | 'commonjs'> {
  if (!packageJsonPath) return null
  const content = safeReadFile(packageJsonPath)
  if (!content) return null

  try {
    const packageJson = JSON.parse(content) as { type?: unknown }
    return packageJson.type === 'module' ? 'module' : 'commonjs'
  } catch {
    return null
  }
}

function findTypeScriptConfigPath(
  projectRoot: string,
  requestAbsolutePath: string
): Nullable<string> {
  const isJavaScript = JavaScriptExtensions.has(extensionWithDot(requestAbsolutePath))
  const configNames = isJavaScript
    ? (['jsconfig.json', 'tsconfig.json'] as const)
    : (['tsconfig.json', 'jsconfig.json'] as const)
  let directory = dirname(requestAbsolutePath)
  let nearestConfigPath: Nullable<string> = null

  while (isPathInside(projectRoot, directory)) {
    for (const configName of configNames) {
      const configPath = resolve(directory, configName)
      if (!existsSync(configPath)) continue

      nearestConfigPath ??= configPath
      const owningConfigPath = findOwningReferencedConfigPath(configPath, requestAbsolutePath)
      // A workspace-wide root config can overlap its narrower node/web configs.
      // Prefer those owning configs over loading every product surface into one program.
      if (
        owningConfigPath &&
        (!typeScriptPathsEqual(directory, projectRoot) ||
          owningConfigPath !== configPath ||
          isJavaScript)
      )
        return owningConfigPath
    }

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  const projectWideConfigPath = findProjectWideOwningConfigPath(projectRoot, requestAbsolutePath)
  if (projectWideConfigPath) return projectWideConfigPath

  // 新建且尚未写入 config include 的文件仍应继承最近配置；已存在并被某个配置拥有的文件
  // 会在上面的包含关系检查中优先命中，避免同时存在 tsconfig/jsconfig 时选错项目。
  return nearestConfigPath
}

function parseTypeScriptConfigFile(configPath: string): Nullable<ts.ParsedCommandLine> {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) return null

  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  )
}

function isTypeScriptConfigCandidatePath(projectRoot: string, absolutePath: string): boolean {
  if (!isPathInside(projectRoot, absolutePath) || !absolutePath.toLowerCase().endsWith('.json'))
    return false

  const relativePath = relative(projectRoot, absolutePath)
  const segments = relativePath.split(sep)
  const fileName = segments.at(-1)?.toLowerCase() ?? ''
  return (
    /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(fileName) ||
    segments.slice(0, -1).some((segment) => /^(?:tsconfig|tsconfigs)$/iu.test(segment))
  )
}

function collectProjectTypeScriptConfigCandidates(
  projectRoot: string
): TypeScriptProjectConfigCandidate[] {
  const cached = projectConfigCandidates.get(projectRoot)
  if (cached) return cached

  const candidates: TypeScriptProjectConfigCandidate[] = []
  const visit = (directory: string): void => {
    if (candidates.length >= MaxTypeScriptConfigCandidates) return

    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      )
    } catch {
      return
    }

    for (const entry of entries) {
      if (candidates.length >= MaxTypeScriptConfigCandidates) return

      const absolutePath = normalizeTypeScriptFileName(resolve(directory, entry.name))
      if (entry.isDirectory()) {
        if (!SkippedDirectoryNames.has(entry.name)) visit(absolutePath)
        continue
      }
      if (!entry.isFile() || !isTypeScriptConfigCandidatePath(projectRoot, absolutePath)) continue

      const parsed = parseTypeScriptConfigFile(absolutePath)
      if (parsed) candidates.push({ configPath: absolutePath, parsed })
    }
  }

  visit(projectRoot)
  projectConfigCandidates.set(projectRoot, candidates)
  return candidates
}

function findProjectWideOwningConfigPath(
  projectRoot: string,
  requestAbsolutePath: string
): Nullable<string> {
  const owningCandidates = collectProjectTypeScriptConfigCandidates(projectRoot)
    .filter(({ parsed }) =>
      parsed.fileNames.some((path) => typeScriptPathsEqual(path, requestAbsolutePath))
    )
    .sort((left, right) => {
      const fileCountDifference = left.parsed.fileNames.length - right.parsed.fileNames.length
      if (fileCountDifference !== 0) return fileCountDifference

      const leftDepth = relative(projectRoot, left.configPath).split(sep).length
      const rightDepth = relative(projectRoot, right.configPath).split(sep).length
      if (leftDepth !== rightDepth) return rightDepth - leftDepth
      return left.configPath.localeCompare(right.configPath)
    })

  return owningCandidates[0]?.configPath ?? null
}

function findOwningReferencedConfigPath(
  configPath: string,
  requestAbsolutePath: string,
  visited = new Set<string>()
): Nullable<string> {
  if (visited.has(configPath)) return null
  visited.add(configPath)

  const parsed = parseTypeScriptConfigFile(configPath)
  if (!parsed) return null

  for (const reference of parsed.projectReferences ?? []) {
    const referencedConfigPath = ts.resolveProjectReferencePath(reference)
    const owningConfigPath = findOwningReferencedConfigPath(
      referencedConfigPath,
      requestAbsolutePath,
      visited
    )
    if (owningConfigPath) return owningConfigPath
  }

  return parsed.fileNames.some((path) => typeScriptPathsEqual(path, requestAbsolutePath))
    ? configPath
    : null
}

function parseTypeScriptProjectConfig(
  projectRoot: string,
  requestAbsolutePath: string
): TypeScriptProjectConfig {
  const discoveredConfigPath = findTypeScriptConfigPath(projectRoot, requestAbsolutePath)
  const configPath = discoveredConfigPath
  const packageJsonPaths = collectPackageJsonPaths(projectRoot, requestAbsolutePath)
  const packageModuleType = readPackageModuleType(packageJsonPaths[0])
  const requestExtension = extensionWithDot(requestAbsolutePath)
  const isExplicitCommonJs = requestExtension === '.cjs' || requestExtension === '.cts'
  const projectDirectory = configPath
    ? dirname(configPath)
    : packageJsonPaths[0]
      ? dirname(packageJsonPaths[0])
      : projectRoot
  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    allowImportingTsExtensions: true,
    allowSyntheticDefaultImports: true,
    checkJs: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: isExplicitCommonJs ? ts.ModuleKind.Node16 : ts.ModuleKind.Preserve,
    moduleDetection:
      packageModuleType === 'module' ? ts.ModuleDetectionKind.Force : ts.ModuleDetectionKind.Auto,
    moduleResolution: isExplicitCommonJs
      ? ts.ModuleResolutionKind.Node16
      : ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  }

  const createConfig = (
    compilerOptions: ts.CompilerOptions,
    fileNames: string[],
    projectReferences?: readonly ts.ProjectReference[]
  ): TypeScriptProjectConfig => {
    const options = createHash('sha1')
      .update(configPath ?? 'inferred')
      .update(projectDirectory)
      .update(JSON.stringify(compilerOptions))
    for (const packageJsonPath of packageJsonPaths) {
      const stats = (() => {
        try {
          return statSync(packageJsonPath)
        } catch {
          return null
        }
      })()
      options.update(packageJsonPath)
      options.update(stats ? `${stats.size}:${stats.mtimeMs}` : 'missing')
    }
    const optionsFingerprint = options.digest('hex')
    const fingerprint = createHash('sha1')
      .update(optionsFingerprint)
      .update(fileNames.join('\0'))
      .digest('hex')

    return {
      projectRoot,
      projectDirectory,
      configPath,
      compilerOptions,
      fileNames: fileNames.map(normalizeTypeScriptFileName),
      projectReferences,
      packageJsonPaths,
      optionsFingerprint,
      fingerprint,
    }
  }

  if (!configPath) return createConfig(fallbackOptions, [])

  const parsed = parseTypeScriptConfigFile(configPath)
  if (!parsed) return createConfig(fallbackOptions, [])

  return createConfig(
    {
      // Solution-style 根配置常常只声明 paths / references；供 ESLint 等工具使用的
      // 派生配置继承它之后，也可能没有 module/moduleResolution。TypeScript 此时会退回
      // 旧 Node10 解析，进而把带 package exports 的现代子路径误报为找不到模块。
      // 仅为未显式声明的选项补齐 Workbench 的现代项目默认值，项目自己的设置仍然优先。
      ...fallbackOptions,
      ...parsed.options,
      allowJs: JavaScriptExtensions.has(extensionWithDot(requestAbsolutePath))
        ? true
        : parsed.options.allowJs,
      noEmit: true,
      skipLibCheck: parsed.options.skipLibCheck ?? true,
    },
    parsed.fileNames,
    parsed.projectReferences
  )
}

function collectTypeScriptFilesFromDisk(projectDirectory: string): Map<string, string> {
  const files = new Map<string, string>()

  const visit = (directory: string): void => {
    if (files.size >= MaxTypeScriptProjectFiles) return

    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.size >= MaxTypeScriptProjectFiles) return

      if (entry.isDirectory()) {
        if (!SkippedDirectoryNames.has(entry.name)) {
          visit(resolve(directory, entry.name))
        }
        continue
      }

      if (!entry.isFile()) continue

      const absolutePath = normalizeTypeScriptFileName(resolve(directory, entry.name))
      if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) continue

      const content = safeReadFile(absolutePath)
      if (content != null) {
        files.set(absolutePath, content)
      }
    }
  }

  visit(projectDirectory)
  return files
}

function readPackageDependencyNames(packageJsonPaths: readonly string[]): string[] {
  const dependencyNames = new Set<string>()

  for (const packageJsonPath of packageJsonPaths) {
    const content = safeReadFile(packageJsonPath)
    if (!content) continue

    try {
      const packageJson = JSON.parse(content) as Record<string, unknown>
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const dependencies = packageJson[field]
        if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
          continue
        for (const dependencyName of Object.keys(dependencies)) dependencyNames.add(dependencyName)
      }
    } catch {
      // arch-guard:silent-catch-ok 无效 package.json 由编辑器诊断负责；语言服务退化为项目内符号，不中断请求。
    }
  }

  return [...dependencyNames].slice(0, MaxPackageTypeEntries)
}

function collectPackageTypeEntryPaths(
  config: TypeScriptProjectConfig,
  requestAbsolutePath: string
): string[] {
  const entryPaths = new Set<string>()

  for (const packageName of readPackageDependencyNames(config.packageJsonPaths)) {
    const resolvedModule = ts.resolveModuleName(
      packageName,
      requestAbsolutePath,
      config.compilerOptions,
      ts.sys
    ).resolvedModule
    if (
      !resolvedModule ||
      !TypeScriptExtensions.has(extensionWithDot(resolvedModule.resolvedFileName))
    ) {
      continue
    }

    entryPaths.add(resolvedModule.resolvedFileName)
  }

  return [...entryPaths]
}

function collectTypeScriptFilesFromConfig(
  config: TypeScriptProjectConfig,
  requestAbsolutePath: string,
  priorityPaths: string[]
): Map<string, string> {
  const files = new Map<string, string>()
  const seen = new Set<string>()

  const addFile = (inputPath: string): void => {
    const absolutePath = normalizeTypeScriptFileName(inputPath)
    if (files.size >= MaxTypeScriptProjectFiles || seen.has(absolutePath)) return
    if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) return

    const content = safeReadFile(absolutePath)
    if (content == null) return

    seen.add(absolutePath)
    files.set(absolutePath, content)
  }

  for (const path of priorityPaths) {
    addFile(path)
  }

  addFile(requestAbsolutePath)

  if (config.fileNames.length > 0) {
    for (const fileName of config.fileNames) {
      addFile(fileName)
    }
    return files
  }

  for (const [path, content] of collectTypeScriptFilesFromDisk(config.projectDirectory)) {
    if (files.size >= MaxTypeScriptProjectFiles) break
    if (seen.has(path)) continue
    seen.add(path)
    files.set(path, content)
  }

  return files
}

function getProjectCacheKey(config: TypeScriptProjectConfig): string {
  return `${config.projectRoot}\0${config.configPath ?? `inferred:${config.projectDirectory}`}`
}

function resolveProjectConfig(
  projectRoot: string,
  requestAbsolutePath: string
): TypeScriptProjectConfig {
  const key = `${projectRoot}\0${requestAbsolutePath}`
  const cached = projectConfigMemo.get(key)
  if (cached) return cached

  const config = parseTypeScriptProjectConfig(projectRoot, requestAbsolutePath)
  projectConfigMemo.set(key, config)
  if (projectConfigMemo.size > MaxMemoizedProjectConfigs) {
    const oldest = projectConfigMemo.keys().next().value
    if (oldest !== undefined) projectConfigMemo.delete(oldest)
  }
  return config
}

/** 这个文件归哪个 TypeScript 项目（tsconfig，或没有配置时推断的目录）；同一项目的文件得到同一个键。 */
export function resolveTypeScriptProjectKey(
  projectRoot: string,
  requestAbsolutePath: string
): string {
  return getProjectCacheKey(resolveProjectConfig(projectRoot, requestAbsolutePath))
}

function forgetProjectConfigs(projectRoot?: string): void {
  if (!projectRoot) {
    projectConfigMemo.clear()
    return
  }
  for (const key of projectConfigMemo.keys()) {
    if (key.startsWith(`${projectRoot}\0`)) projectConfigMemo.delete(key)
  }
}

/**
 * 项目的源文件清单可能变了（新建、删除了 TS 文件）：忘掉记住的配置，下一次请求重新解析 tsconfig；
 * 已建的服务按新清单增删根文件，TypeScript 增量更新程序，不整体重建。
 */
export function invalidateTypeScriptProjectConfigs(projectRoot: string): void {
  projectConfigCandidates.delete(projectRoot)
  forgetProjectConfigs(projectRoot)
}

/**
 * 只是文件清单变了（编译选项、配置、依赖都没变）：新进清单的文件读进来当根文件，从清单里消失且磁盘上
 * 也没有了的移出去。旧做法是丢掉整个服务重新建库、重新类型检查，Agent 每新建一个文件编辑器就停顿好几秒。
 */
function reconcileProjectFileNames(
  cacheKey: string,
  entry: TypeScriptProjectCacheEntry,
  config: TypeScriptProjectConfig
): void {
  const pooled = pooledProjects.get(cacheKey)
  const previousFileNames = new Set(entry.config.fileNames)
  const nextFileNames = new Set(config.fileNames)

  for (const fileName of config.fileNames) {
    if (previousFileNames.has(fileName) || entry.diskFiles.has(fileName)) continue
    if (entry.diskFiles.size >= MaxTypeScriptProjectFiles) break
    if (!TypeScriptExtensions.has(extensionWithDot(fileName))) continue
    const content = safeReadFile(fileName)
    if (content == null) continue
    entry.diskFiles.set(fileName, content)
    if (pooled && !pooled.overlayPaths.has(fileName)) setPooledFile(pooled, fileName, content)
  }

  for (const fileName of entry.config.fileNames) {
    if (nextFileNames.has(fileName) || !entry.diskFiles.has(fileName)) continue
    if (safeReadFile(fileName) != null) continue
    entry.diskFiles.delete(fileName)
    if (pooled && !pooled.overlayPaths.has(fileName)) pooled.liveFiles.delete(fileName)
  }
}

function getOrCreateProjectCache(
  projectRoot: string,
  requestAbsolutePath: string,
  priorityPaths: string[]
): TypeScriptProjectCacheEntry {
  const config = resolveProjectConfig(projectRoot, requestAbsolutePath)
  const cacheKey = getProjectCacheKey(config)
  const cached = projectCache.get(cacheKey)
  if (cached?.config.fingerprint === config.fingerprint) return cached
  if (cached && cached.config.optionsFingerprint === config.optionsFingerprint) {
    reconcileProjectFileNames(cacheKey, cached, config)
    cached.config = config
    return cached
  }

  const pooledProject = pooledProjects.get(cacheKey)
  pooledProject?.service.dispose()
  pooledProjects.delete(cacheKey)

  const diskFiles = collectTypeScriptFilesFromConfig(config, requestAbsolutePath, priorityPaths)
  const entry: TypeScriptProjectCacheEntry = {
    cacheKey,
    config,
    diskFiles,
    packageImportsLoaded: false,
  }
  projectCache.set(cacheKey, entry)
  return entry
}

/** Add unimported dependency exports only when ordinary completion candidates do not match. */
export function includeTypeScriptPackageAutoImports(
  projectRoot: string,
  requestAbsolutePath: string
): boolean {
  const entry = getOrCreateProjectCache(projectRoot, requestAbsolutePath, [requestAbsolutePath])
  if (entry.packageImportsLoaded) return false
  entry.packageImportsLoaded = true
  const project = pooledProjects.get(entry.cacheKey)
  let changed = false
  for (const path of collectPackageTypeEntryPaths(entry.config, requestAbsolutePath)) {
    const fileName = normalizeTypeScriptFileName(path)
    if (entry.diskFiles.has(fileName) || entry.diskFiles.size >= MaxTypeScriptProjectFiles) continue
    const content = safeReadFile(fileName)
    if (content == null) continue
    entry.diskFiles.set(fileName, content)
    if (project && !project.overlayPaths.has(fileName)) setPooledFile(project, fileName, content)
    changed = true
  }
  return changed
}

function setPooledFile(project: PooledTypeScriptProject, inputPath: string, content: string): void {
  const fileName = normalizeTypeScriptFileName(inputPath)
  // Only bump the version when the content actually changes. Stable versions let the
  // TypeScript language service reuse its cached parse/type-check results for every
  // untouched file instead of rebuilding the whole program on each request.
  if (project.liveFiles.get(fileName) === content) return
  project.liveFiles.set(fileName, content)
  project.fileVersions.set(fileName, (project.fileVersions.get(fileName) ?? 0) + 1)
}

let isTypeScriptRequestCancelled: () => boolean = () => false
/** TypeScript 只在建服务时取一次取消令牌：令牌本身不变，每次检查时再问当前请求是否已被顶掉。 */
const typeScriptCancellationToken: ts.HostCancellationToken = {
  isCancellationRequested: () => isTypeScriptRequestCancelled(),
}

/** worker 注入「正在算的请求是否已被取消」；TypeScript 在补全、语义着色等计算的检查点问它。 */
export function configureTypeScriptCancellation(isCancelled: () => boolean): void {
  isTypeScriptRequestCancelled = isCancelled
}

/**
 * TypeScript 的语言服务宿主上有、公开类型里没有的一个口子（tsserver 自己的项目实现了它）：声明文件的位置映射
 * 由宿主给。TypeScript 换了名字的话这一项只是不再生效，它照旧自己去读映射。
 */
interface TypeScriptLanguageServiceHostInternals {
  getDocumentPositionMapper?: (generatedFileName: string, sourceFileName?: string) => undefined
}

function createLanguageServiceHost(
  project: PooledTypeScriptProject
): ts.LanguageServiceHost & TypeScriptLanguageServiceHostInternals {
  return {
    getCancellationToken: () => typeScriptCancellationToken,
    getCompilationSettings: () => project.compilerOptions,
    getProjectVersion: () => project.frozenVersion,
    // 不读依赖包里的声明映射（`.d.ts.map`）。语言服务里只有「文件改名后更新 import」会用它：把指向别的项目
    // 构建产物的 import 对回源文件。这里没有这种用法，而不挡掉的话每次改名都要把程序里几千个声明文件的映射
    // 逐个找出来、读进来、解码一遍。
    getDocumentPositionMapper: () => undefined,
    getScriptFileNames: () => [...project.liveFiles.keys()],
    getScriptVersion: (fileName) =>
      String(project.fileVersions.get(normalizeTypeScriptFileName(fileName)) ?? 0),
    getScriptSnapshot: (inputPath) => {
      const fileName = normalizeTypeScriptFileName(inputPath)
      const content =
        project.liveFiles.get(fileName) ?? safeReadFile(fileName) ?? ts.sys.readFile(fileName)
      return content == null ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => project.projectDirectory,
    // TypeScript itself is bundled into Workbench's main process, so its own
    // __dirname no longer points at node_modules/typescript/lib after packaging.
    // The release therefore ships the standard library declarations as an
    // app resource and the language host explicitly anchors lib resolution there.
    getDefaultLibFileName: (options) => resolveTypeScriptDefaultLibFilePath(options),
    fileExists: (fileName) =>
      project.liveFiles.has(normalizeTypeScriptFileName(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) =>
      project.liveFiles.get(normalizeTypeScriptFileName(fileName)) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectReferences: () => project.projectReferences,
  }
}

function disposePooledProject(key: string): void {
  const project = pooledProjects.get(key)
  if (!project) return
  pooledProjects.delete(key)
  projectCache.delete(key)
  project.service.dispose()
}

function evictLeastRecentlyUsedProjects(keep: string): void {
  while (pooledProjects.size > pooledProjectLimit) {
    const oldest = [...pooledProjects.keys()].find((key) => key !== keep)
    if (!oldest) return
    disposePooledProject(oldest)
  }
}

export type WorkbenchTypeScriptTrimLevel = 'semantic' | 'inactive' | 'all'

/**
 * 主动释放内存。
 * - `semantic`：只丢类型检查缓存（每个服务几十到一百多 MB），下一次请求重新检查即可，文件解析结果都还在。
 * - `inactive`：最近用的那个服务留着，其余整个丢掉。
 * - `all`：全部丢掉，下一次请求从磁盘重建。
 */
export function trimTypeScriptProjects(level: WorkbenchTypeScriptTrimLevel): number {
  if (level === 'semantic') {
    for (const project of pooledProjects.values()) project.service.cleanupSemanticCache()
    return 0
  }
  const keys = [...pooledProjects.keys()]
  const victims = level === 'all' ? keys : keys.slice(0, -1)
  for (const key of victims) disposePooledProject(key)
  return victims.length
}

export interface WorkbenchTypeScriptProjectMemorySummary {
  projects: number
  files: number
}

export function describeTypeScriptProjects(): WorkbenchTypeScriptProjectMemorySummary {
  let files = 0
  for (const project of pooledProjects.values()) files += project.liveFiles.size
  return { projects: pooledProjects.size, files }
}

export function clearTypeScriptProjectCache(projectRoot?: string): void {
  forgetProjectConfigs(projectRoot)
  if (!projectRoot) {
    for (const project of pooledProjects.values()) project.service.dispose()
    projectCache.clear()
    pooledProjects.clear()
    projectConfigCandidates.clear()
    return
  }

  projectConfigCandidates.delete(projectRoot)

  for (const key of projectCache.keys()) {
    if (key.startsWith(`${projectRoot}\0`)) {
      projectCache.delete(key)
    }
  }

  for (const key of pooledProjects.keys()) {
    if (key.startsWith(`${projectRoot}\0`)) {
      pooledProjects.get(key)?.service.dispose()
      pooledProjects.delete(key)
    }
  }
}

function isTypeScriptProjectMetadataPath(projectRoot: string, absolutePath: string): boolean {
  return (
    basename(absolutePath) === 'package.json' ||
    isTypeScriptConfigCandidatePath(projectRoot, absolutePath)
  )
}

/**
 * 一个磁盘文件的最新内容（null = 已不存在）写进项目缓存与已建的服务。
 * `keepOverlay`：正被编辑器覆盖（有未保存改动）的文件只更新磁盘版本，编辑缓冲仍是权威；
 * 旧位置退出项目时则撤下覆盖层。
 * 版本号只增不减：文件删了再建也不能回到旧版本号，否则 TypeScript 会当成没变过而沿用旧文本。
 */
function applyDiskFileToProjects(
  projectRoot: string,
  inputPath: string,
  content: Nullable<string>,
  keepOverlay: boolean,
  consumingProjects?: ReadonlySet<string>
): void {
  const absolutePath = normalizeTypeScriptFileName(inputPath)
  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (
      !isPathInside(cacheEntry.config.projectDirectory, absolutePath) &&
      !cacheEntry.diskFiles.has(absolutePath) &&
      !consumingProjects?.has(key)
    )
      continue
    if (content == null) cacheEntry.diskFiles.delete(absolutePath)
    else cacheEntry.diskFiles.set(absolutePath, content)
  }

  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (
      !isPathInside(project.projectDirectory, absolutePath) &&
      !project.liveFiles.has(absolutePath) &&
      !project.diskFiles.has(absolutePath) &&
      !consumingProjects?.has(key)
    )
      continue

    if (content == null) project.diskFiles.delete(absolutePath)
    else project.diskFiles.set(absolutePath, content)
    if (keepOverlay && project.overlayPaths.has(absolutePath)) continue

    project.overlayPaths.delete(absolutePath)
    if (content == null) {
      project.liveFiles.delete(absolutePath)
      // import 拉进来的文件未必是根文件；删除也要撤销 TypeScript 缓存的 SourceFile。
      project.fileVersions.set(absolutePath, (project.fileVersions.get(absolutePath) ?? 0) + 1)
    } else setPooledFile(project, absolutePath, content)
  }
}

/**
 * 磁盘上这些路径变了（文件监听送到的、Agent 或用户刚写完的）：按此刻的磁盘内容更新已建的 TypeScript 项目，
 * 下一次诊断才不会照着旧文件算。以前这些改动根本到不了这里：项目建好后磁盘文件只在 package.json / tsconfig
 * 变化时整体重读，别的文件一直是首次扫描时的文本，跨文件的错误修好了也不消。
 *
 * 只更新项目已经认得的文件——项目根文件，以及被 import 拉进程序的文件；别的新文件被 import 时 TypeScript
 * 自己会发现（缺失文件复查），在编辑器里打开时成为请求文件。package.json / tsconfig 变了整个项目重建。
 */
export function refreshTypeScriptProjectFilesFromDisk(
  projectRoot: string,
  absolutePaths: readonly string[]
): void {
  const scriptPaths = new Set<string>()
  for (const absolutePath of absolutePaths) {
    if (!isPathInside(projectRoot, absolutePath)) continue
    if (isTypeScriptProjectMetadataPath(projectRoot, absolutePath)) {
      clearTypeScriptProjectCache(projectRoot)
      return
    }
    if (TypeScriptExtensions.has(extensionWithDot(absolutePath)))
      scriptPaths.add(normalizeTypeScriptFileName(absolutePath))
  }
  if (scriptPaths.size === 0) return

  const consumersByPath = new Map<string, Set<string>>()
  const rememberConsumer = (absolutePath: string, projectKey: string): void => {
    const consumers = consumersByPath.get(absolutePath) ?? new Set<string>()
    consumers.add(projectKey)
    consumersByPath.set(absolutePath, consumers)
  }
  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    for (const absolutePath of scriptPaths)
      if (cacheEntry.diskFiles.has(absolutePath)) rememberConsumer(absolutePath, key)
  }
  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    // 程序只取一次：更新过一个文件的版本再取会触发增量重建，一批改动就成了一批次重建。
    const program = currentTypeScriptProgram(project)
    for (const absolutePath of scriptPaths) {
      if (project.liveFiles.has(absolutePath) || program?.getSourceFile(absolutePath))
        rememberConsumer(absolutePath, key)
    }
  }

  // 认得的文件没了、不认得的文件出现了：文件清单可能变了，记住的配置作废（只重新解析，不重建服务）。
  let fileListMayHaveChanged = false
  for (const absolutePath of scriptPaths) {
    const consumers = consumersByPath.get(absolutePath)
    if (consumers) {
      const content = safeReadFile(absolutePath)
      if (content == null) fileListMayHaveChanged = true
      // 被兄弟包 import 的文件也属于实际消费者；不能只按 tsconfig 所在目录判断。
      applyDiskFileToProjects(projectRoot, absolutePath, content, true, consumers)
    } else if (existsSync(absolutePath)) {
      fileListMayHaveChanged = true
    }
  }
  if (fileListMayHaveChanged) {
    invalidateTypeScriptProjectConfigs(projectRoot)
    // 缺过的跨包文件重新出现时，配置的根文件清单可能不变；不能沿用旧 Program 的失败解析。
    // 只清结构变化后的 Program，保留 service、覆盖层与版本；普通正文更新继续增量复用。
    for (const [key, project] of pooledProjects)
      if (key.startsWith(`${projectRoot}\0`)) project.service.cleanupSemanticCache()
  }
}

/**
 * 一个文件或目录被改名 / 挪走了：项目里记着的、在旧位置（或它下面）而磁盘上已经没有的文件退出项目，并忘掉记住
 * 的配置，下一次请求按新清单对齐根文件。目录改名时通知里只有目录自己的路径，
 * {@link refreshTypeScriptProjectFilesFromDisk} 认不出它下面是哪些文件；没有 tsconfig 的项目又不会靠重新解析
 * 配置把它们清出去，它们就一直留在程序里当根文件，「整项目检查」接着查这些已经不存在的文件。
 *
 * 连自己的目录（tsconfig 所在）都被挪走了的项目整个丢掉：它的键是旧路径，再不会有请求落到它头上。
 */
export function forgetMovedTypeScriptProjectPath(
  projectRoot: string,
  previousAbsolutePath: string
): void {
  const prefix = `${projectRoot}\0`
  for (const key of [...pooledProjects.keys()]) {
    if (!key.startsWith(prefix)) continue
    const projectDirectory = pooledProjects.get(key)?.projectDirectory
    if (projectDirectory && !existsSync(projectDirectory)) disposePooledProject(key)
  }

  const moved = new Set<string>()
  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(prefix)) continue
    for (const fileName of cacheEntry.diskFiles.keys())
      if (isPathInside(previousAbsolutePath, fileName)) moved.add(fileName)
  }
  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(prefix)) continue
    for (const fileName of project.liveFiles.keys())
      if (isPathInside(previousAbsolutePath, fileName)) moved.add(fileName)
  }
  for (const fileName of moved)
    if (!existsSync(fileName)) applyDiskFileToProjects(projectRoot, fileName, null, false)
  invalidateTypeScriptProjectConfigs(projectRoot)
}

/**
 * 挪到这个位置的 JS/TS 文件与它们的磁盘正文：路径是文件就是它自己，是目录就是它下面的（node_modules、构建
 * 产物这类目录不看，自己就在这类目录里的也不看）。一个都没有说明这次移动与 TypeScript 无关。
 */
export function readMovedTypeScriptFiles(
  projectRoot: string,
  absolutePath: string
): Map<string, string> {
  if (!isPathInside(projectRoot, absolutePath)) return new Map()
  if (
    relative(projectRoot, absolutePath)
      .split(sep)
      .some((segment) => SkippedDirectoryNames.has(segment))
  )
    return new Map()

  const content = safeReadFile(absolutePath)
  if (content != null)
    return TypeScriptExtensions.has(extensionWithDot(absolutePath))
      ? new Map([[normalizeTypeScriptFileName(absolutePath), content]])
      : new Map()
  return collectTypeScriptFilesFromDisk(absolutePath)
}

/** 为一个项目找请求文件时最多试这么多个：每试一个都要重新解析一遍配置。 */
const MaxProjectAnchorProbes = 8

/**
 * 文件挪了位置以后，该去问哪些项目「引用它们的 import 要怎么改」。每个项目给一个落在它头上的请求文件，
 * 按该问的先后排：
 *
 * 1. 被挪文件现在归的项目（每组第一个文件说了算）；
 * 2. 文件清单里有被挪文件的别的配置。一个文件常常同时归几个配置管——`tsconfig.json` 只管 `src`，
 *    `tsconfig.eslint.json` / `tsconfig.test.json` 连测试一起管——只问第一种的话，测试里的 import 没人改。
 *    这些项目多半还没建；池子里有空位才为此新建，不为它们挤掉正在用的项目；
 * 3. 其余已经建着的项目（别的包可能经相对路径、别名引用着被挪的文件），从最久没用的排到最近用的：
 *    挨个取用之后，它们在池子里的先后不变。
 */
export function planTypeScriptFileRenameProjects(
  projectRoot: string,
  movedFileGroups: ReadonlyArray<readonly string[]>
): string[] {
  const prefix = `${projectRoot}\0`
  const keyOf = (fileName: string): string =>
    getProjectCacheKey(resolveProjectConfig(projectRoot, fileName))
  const isCandidateAnchor = (fileName: string): boolean =>
    TypeScriptExtensions.has(extensionWithDot(fileName)) &&
    !/[\\/]node_modules[\\/]/u.test(fileName) &&
    existsSync(fileName)
  const findAnchor = (key: string, fileNames: Iterable<string>): string | undefined => {
    let probes = 0
    for (const fileName of fileNames) {
      if (!isCandidateAnchor(fileName)) continue
      if (keyOf(fileName) === key) return fileName
      probes += 1
      if (probes >= MaxProjectAnchorProbes) return undefined
    }
    return undefined
  }

  const toBuild = new Map<string, string>()
  const owners = new Map<string, string>()
  for (const group of movedFileGroups) {
    const anchor = group[0]
    if (!anchor) continue
    const key = keyOf(anchor)
    if (owners.has(key)) continue
    owners.set(key, anchor)
    if (!pooledProjects.has(key)) toBuild.set(key, anchor)
  }

  const moved = new Set(movedFileGroups.flat().map(canonicalTypeScriptPath))
  const candidates = collectProjectTypeScriptConfigCandidates(projectRoot)
  const listing = candidates.filter(({ parsed }) =>
    parsed.fileNames.some((fileName) => moved.has(canonicalTypeScriptPath(fileName)))
  )
  if (listing.length > 0) {
    // 只归一个配置管的文件一定落到它头上，先试它们。
    const listedBy = new Map<string, number>()
    for (const { parsed } of candidates)
      for (const fileName of parsed.fileNames) {
        const canonical = canonicalTypeScriptPath(fileName)
        listedBy.set(canonical, (listedBy.get(canonical) ?? 0) + 1)
      }
    for (const { configPath, parsed } of listing) {
      if (pooledProjects.size + toBuild.size >= pooledProjectLimit) break
      const key = `${prefix}${configPath}`
      if (owners.has(key) || pooledProjects.has(key)) continue
      const anchor = findAnchor(key, [
        ...parsed.fileNames.filter(
          (fileName) => listedBy.get(canonicalTypeScriptPath(fileName)) === 1
        ),
        ...parsed.fileNames,
      ])
      if (anchor) toBuild.set(key, anchor)
    }
  }

  const built: string[] = []
  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(prefix)) continue
    const anchor =
      owners.get(key) ??
      findAnchor(key, [
        project.requestFileName,
        ...(projectCache.get(key)?.config.fileNames ?? []),
        ...project.diskFiles.keys(),
      ])
    if (anchor) built.push(anchor)
  }
  return [...toBuild.values(), ...built]
}

let frozenVersionSerial = 0

/**
 * 一段同步计算当中项目的文件不会变：告诉 TypeScript 这期间不必每次要程序都重新核对一遍（根文件清单、每个源文件
 * 的版本、缺过的文件又有了没有）。
 *
 * 为 getEditsForFileRename 而设：它对程序里每个文件、每条 import 都要经 source mapper 问一次「这个声明文件在不在
 * 程序里」，每问一次就取一次程序。带着依赖有八千多个文件的项目里，不这样做一次改名要算十几分钟；这样做是几秒。
 * 平时不给项目版本：TypeScript 每次调用核对一遍，缺过的文件出现了它自己能发现，这里不改这个行为。
 */
export function freezeTypeScriptProgramWhile<T>(service: ts.LanguageService, run: () => T): T {
  const project = [...pooledProjects.values()].find((candidate) => candidate.service === service)
  if (!project) return run()

  // 每次用一个新的版本号：进来的第一次取程序照常核对，之后的才跳过。
  frozenVersionSerial += 1
  project.frozenVersion = `frozen-${frozenVersionSerial}`
  try {
    return run()
  } finally {
    project.frozenVersion = ''
  }
}

function currentTypeScriptProgram(project: PooledTypeScriptProject): ts.Program | undefined {
  try {
    return project.service.getProgram()
  } catch {
    // arch-guard:silent-catch-ok 程序同步失败只影响「这个文件算不算已知」的判断；下一次请求会重建程序。
    return undefined
  }
}

export function acquireTypeScriptLanguageService(
  projectRoot: string,
  inputRequestPath: string,
  inputPriorityPaths: string[],
  overlayFiles: Map<string, string>,
  preserveExistingOverlays = false
): {
  service: ts.LanguageService
  files: Map<string, string>
  compilerOptions: ts.CompilerOptions
  config: TypeScriptProjectConfig
} {
  const requestAbsolutePath = normalizeTypeScriptFileName(inputRequestPath)
  const priorityPaths = inputPriorityPaths.map(normalizeTypeScriptFileName)
  const cacheEntry = getOrCreateProjectCache(projectRoot, requestAbsolutePath, priorityPaths)
  const poolKey = cacheEntry.cacheKey

  let project = pooledProjects.get(poolKey)
  if (!project) {
    const liveFiles = new Map(cacheEntry.diskFiles)
    const fileVersions = new Map<string, number>()
    for (const [path] of liveFiles) {
      fileVersions.set(path, 1)
    }

    const draft: PooledTypeScriptProject = {
      projectRoot,
      projectDirectory: cacheEntry.config.projectDirectory,
      requestFileName: requestAbsolutePath,
      frozenVersion: '',
      compilerOptions: cacheEntry.config.compilerOptions,
      projectReferences: cacheEntry.config.projectReferences,
      diskFiles: cacheEntry.diskFiles,
      liveFiles,
      fileVersions,
      overlayPaths: new Set(),
      service: null as unknown as ts.LanguageService,
    }
    draft.service = ts.createLanguageService(createLanguageServiceHost(draft), documentRegistry())
    project = draft
    pooledProjects.set(poolKey, project)
    evictLeastRecentlyUsedProjects(poolKey)
  } else {
    pooledProjects.delete(poolKey)
    pooledProjects.set(poolKey, project)
    project.requestFileName = requestAbsolutePath
  }

  // Reconcile only the dirty (overlay) files against the previous request. Disk files
  // keep their existing versions untouched so TypeScript preserves its incremental caches.
  const nextOverlayPaths = preserveExistingOverlays
    ? new Set(project.overlayPaths)
    : new Set<string>()
  for (const [path, content] of overlayFiles) {
    if (!TypeScriptExtensions.has(extensionWithDot(path))) continue
    setPooledFile(project, path, content)
    nextOverlayPaths.add(normalizeTypeScriptFileName(path))
  }

  for (const path of preserveExistingOverlays ? [] : project.overlayPaths) {
    if (nextOverlayPaths.has(path)) continue

    // 编辑器不再覆盖这个文件（保存了、标签干净了、关掉了）：回到磁盘内容。缓存里的磁盘版本可能已经过时
    // （刚保存的内容还没经文件监听送回来），所以项目认得的文件直接重读一次；不属于项目的文件照旧退出程序。
    if (!project.diskFiles.has(path)) {
      project.liveFiles.delete(path)
      continue
    }
    const diskContent = safeReadFile(path)
    if (diskContent == null) {
      project.diskFiles.delete(path)
      project.liveFiles.delete(path)
    } else {
      project.diskFiles.set(path, diskContent)
      setPooledFile(project, path, diskContent)
    }
  }

  project.overlayPaths = nextOverlayPaths

  return {
    service: project.service,
    files: project.liveFiles,
    compilerOptions: project.compilerOptions,
    config: cacheEntry.config,
  }
}

export {
  extensionWithDot,
  isPathInside,
  resolveTypeScriptDefaultLibFilePath,
  safeReadFile,
  TypeScriptExtensions,
}
