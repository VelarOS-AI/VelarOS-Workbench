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

const projectCache = new Map<string, TypeScriptProjectCacheEntry>()
const pooledProjects = new Map<string, PooledTypeScriptProject>()
const projectConfigCandidates = new Map<string, TypeScriptProjectConfigCandidate[]>()

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
    const fingerprint = createHash('sha1')
      .update(configPath ?? 'inferred')
      .update(projectDirectory)
      .update(JSON.stringify(compilerOptions))
      .update(fileNames.join('\0'))
    for (const packageJsonPath of packageJsonPaths) {
      const stats = (() => {
        try {
          return statSync(packageJsonPath)
        } catch {
          return null
        }
      })()
      fingerprint.update(packageJsonPath)
      fingerprint.update(stats ? `${stats.size}:${stats.mtimeMs}` : 'missing')
    }

    return {
      projectRoot,
      projectDirectory,
      configPath,
      compilerOptions,
      fileNames,
      projectReferences,
      packageJsonPaths,
      fingerprint: fingerprint.digest('hex'),
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

function getOrCreateProjectCache(
  projectRoot: string,
  requestAbsolutePath: string,
  priorityPaths: string[]
): TypeScriptProjectCacheEntry {
  const config = parseTypeScriptProjectConfig(projectRoot, requestAbsolutePath)
  const cacheKey = getProjectCacheKey(config)
  const cached = projectCache.get(cacheKey)
  if (cached?.config.fingerprint === config.fingerprint) return cached

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

export function synchronizeTypeScriptProjectFile(
  projectRoot: string,
  absolutePath: string,
  content: Nullable<string>
): void {
  if (!isPathInside(projectRoot, absolutePath)) return

  const fileName = basename(absolutePath)
  const isProjectMetadata =
    fileName === 'package.json' || isTypeScriptConfigCandidatePath(projectRoot, absolutePath)
  if (isProjectMetadata) {
    clearTypeScriptProjectCache(projectRoot)
    return
  }

  if (!TypeScriptExtensions.has(extensionWithDot(absolutePath))) return

  for (const [key, cacheEntry] of projectCache) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (!isPathInside(cacheEntry.config.projectDirectory, absolutePath)) continue
    if (content == null) cacheEntry.diskFiles.delete(absolutePath)
    else cacheEntry.diskFiles.set(absolutePath, content)
  }

  for (const [key, project] of pooledProjects) {
    if (!key.startsWith(`${projectRoot}\0`)) continue
    if (!isPathInside(project.projectDirectory, absolutePath)) continue

    project.overlayPaths.delete(absolutePath)
    if (content == null) {
      project.diskFiles.delete(absolutePath)
      project.liveFiles.delete(absolutePath)
      project.fileVersions.delete(absolutePath)
    } else {
      project.diskFiles.set(absolutePath, content)
      setPooledFile(project, absolutePath, content)
    }
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

    const diskContent = project.diskFiles.get(path)
    if (diskContent == null) {
      project.liveFiles.delete(path)
      project.fileVersions.delete(path)
    } else {
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
