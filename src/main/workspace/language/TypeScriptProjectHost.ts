import { createHash } from 'node:crypto'
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import * as ts from 'typescript'

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
}

interface PooledTypeScriptProject {
  projectRoot: string
  projectDirectory: string
  compilerOptions: ts.CompilerOptions
  projectReferences?: readonly ts.ProjectReference[]
  diskFiles: Map<string, string>
  liveFiles: Map<string, string>
  fileVersions: Map<string, number>
  overlayPaths: Set<string>
  service: ts.LanguageService
}

const MaxMemoizedProjectConfigs = 256
const projectCache = new Map<string, TypeScriptProjectCacheEntry>()
const pooledProjects = new Map<string, PooledTypeScriptProject>()
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
  resourcesPath: Nullable<string> = process.resourcesPath
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

function safeReadFile(path: string): Nullable<string> {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath)
  return (
    childRelativePath === '' ||
    (childRelativePath !== '..' &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath))
  )
}

function typeScriptPathsEqual(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const absolutePath = resolve(path).replaceAll('\\', '/')
    return ts.sys.useCaseSensitiveFileNames ? absolutePath : absolutePath.toLowerCase()
  }
  return normalize(left) === normalize(right)
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
      if (owningConfigPath) return owningConfigPath
    }

    if (directory === projectRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  const projectWideConfigPath = findProjectWideOwningConfigPath(
    projectRoot,
    requestAbsolutePath
  )
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

      const absolutePath = resolve(directory, entry.name)
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
    .filter(({ parsed }) => parsed.fileNames.some((path) =>
      typeScriptPathsEqual(path, requestAbsolutePath)
    ))
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
      fileNames,
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

      const absolutePath = resolve(directory, entry.name)
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

  const addFile = (absolutePath: string): void => {
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

  // Standalone LanguageService 没有 tsserver 的 auto-import provider；把依赖包的类型入口作为
  // 项目根文件注入，React/Vue/Vite 等包导出的 API 才会进入自动导入候选。
  for (const entryPath of collectPackageTypeEntryPaths(config, requestAbsolutePath)) {
    addFile(entryPath)
  }

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
  const entry: TypeScriptProjectCacheEntry = { cacheKey, config, diskFiles }
  projectCache.set(cacheKey, entry)
  return entry
}

function setPooledFile(project: PooledTypeScriptProject, fileName: string, content: string): void {
  // Only bump the version when the content actually changes. Stable versions let the
  // TypeScript language service reuse its cached parse/type-check results for every
  // untouched file instead of rebuilding the whole program on each request.
  if (project.liveFiles.get(fileName) === content) return
  project.liveFiles.set(fileName, content)
  project.fileVersions.set(fileName, (project.fileVersions.get(fileName) ?? 0) + 1)
}

function createLanguageServiceHost(project: PooledTypeScriptProject): ts.LanguageServiceHost {
  return {
    getCompilationSettings: () => project.compilerOptions,
    getScriptFileNames: () => [...project.liveFiles.keys()],
    getScriptVersion: (fileName) => String(project.fileVersions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
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
    fileExists: (fileName) => project.liveFiles.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => project.liveFiles.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectReferences: () => project.projectReferences,
  }
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
 * 否则这份内容就是权威（显式同步），覆盖层一并撤掉。
 * 版本号只增不减：文件删了再建也不能回到旧版本号，否则 TypeScript 会当成没变过而沿用旧文本。
 */
function applyDiskFileToProjects(
  projectRoot: string,
  absolutePath: string,
  content: Nullable<string>,
  keepOverlay: boolean
): void {
  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (!isPathInside(cacheEntry.config.projectDirectory, absolutePath)) continue
    if (content == null) cacheEntry.diskFiles.delete(absolutePath)
    else cacheEntry.diskFiles.set(absolutePath, content)
  }

  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (!isPathInside(project.projectDirectory, absolutePath)) continue

    if (content == null) project.diskFiles.delete(absolutePath)
    else project.diskFiles.set(absolutePath, content)
    if (keepOverlay && project.overlayPaths.has(absolutePath)) continue

    project.overlayPaths.delete(absolutePath)
    if (content == null) project.liveFiles.delete(absolutePath)
    else setPooledFile(project, absolutePath, content)
  }
}

export function synchronizeTypeScriptProjectFile(
  projectRoot: string,
  absolutePath: string,
  content: Nullable<string>
): void {
  if (!isPathInside(projectRoot, absolutePath)) return
  if (isTypeScriptProjectMetadataPath(projectRoot, absolutePath)) {
    clearTypeScriptProjectCache(projectRoot)
    return
  }
  if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) return

  applyDiskFileToProjects(projectRoot, absolutePath, content, false)
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
    if (TypeScriptExtensions.has(extensionWithDot(absolutePath))) scriptPaths.add(absolutePath)
  }
  if (scriptPaths.size === 0) return

  const knownPaths = new Set<string>()
  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    for (const absolutePath of scriptPaths)
      if (cacheEntry.diskFiles.has(absolutePath)) knownPaths.add(absolutePath)
  }
  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    // 程序只取一次：更新过一个文件的版本再取会触发增量重建，一批改动就成了一批次重建。
    const program = currentTypeScriptProgram(project)
    for (const absolutePath of scriptPaths) {
      if (project.liveFiles.has(absolutePath) || program?.getSourceFile(absolutePath))
        knownPaths.add(absolutePath)
    }
  }

  // 认得的文件没了、不认得的文件出现了：文件清单可能变了，记住的配置作废（只重新解析，不重建服务）。
  let fileListMayHaveChanged = false
  for (const absolutePath of scriptPaths) {
    if (knownPaths.has(absolutePath)) {
      const content = safeReadFile(absolutePath)
      if (content == null) fileListMayHaveChanged = true
      applyDiskFileToProjects(projectRoot, absolutePath, content, true)
    } else if (existsSync(absolutePath)) {
      fileListMayHaveChanged = true
    }
  }
  if (fileListMayHaveChanged) invalidateTypeScriptProjectConfigs(projectRoot)
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
  requestAbsolutePath: string,
  priorityPaths: string[],
  overlayFiles: Map<string, string>,
  preserveExistingOverlays = false
): {
  service: ts.LanguageService
  files: Map<string, string>
  compilerOptions: ts.CompilerOptions
  config: TypeScriptProjectConfig
} {
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
      compilerOptions: cacheEntry.config.compilerOptions,
      projectReferences: cacheEntry.config.projectReferences,
      diskFiles: cacheEntry.diskFiles,
      liveFiles,
      fileVersions,
      overlayPaths: new Set(),
      service: null as unknown as ts.LanguageService,
    }
    draft.service = ts.createLanguageService(createLanguageServiceHost(draft))
    project = draft
    pooledProjects.set(poolKey, project)
  }

  // Reconcile only the dirty (overlay) files against the previous request. Disk files
  // keep their existing versions untouched so TypeScript preserves its incremental caches.
  const nextOverlayPaths = preserveExistingOverlays
    ? new Set(project.overlayPaths)
    : new Set<string>()
  for (const [path, content] of overlayFiles) {
    if (!TypeScriptExtensions.has(extensionWithDot(path))) continue
    setPooledFile(project, path, content)
    nextOverlayPaths.add(path)
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
  resolveTypeScriptDefaultLibFilePath,
  safeReadFile,
  TypeScriptExtensions,
}
