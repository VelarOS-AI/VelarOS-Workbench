// 用途：按外部 ESM 包的真实依赖与发布资源，核验 ASAR 中可解析的模块入口和包内容（移植自 Desktop 的同名门禁）。
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import ts from 'typescript'

const HostModules = new Set([
  'electron',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])
const SourceOnly = /(?:\.map|\.d\.[cm]?ts|\.tsx?|\.mts|\.cts|\.tsbuildinfo|\.pyc|\.pyo)$/iu
const DevelopmentOnly = /(?:^|\/)(?:test|tests|spec|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?js$/iu
const CodeFile = /\.[cm]?js$/iu

/** ScriptAct 模版里的 `velaros` / `velaros:*` 由脚本运行时注入，不是 Node 依赖，不在 asar 里。 */
function isScriptRuntimeModule(specifier) {
  return specifier === 'velaros' || specifier.startsWith('velaros:')
}

/** 从包自己的查找路径解析依赖，保留 workspace 链接的实际版本身份。 */
export function installedPackage(name, parent, optional = false) {
  const lookup = createRequire(join(parent, 'package.json')).resolve.paths(`${name}/package.json`) ?? []
  for (const directory of lookup) {
    const path = join(directory, name, 'package.json')
    if (!existsSync(path)) continue
    const root = dirname(realpathSync(path))
    return { name, root, manifest: JSON.parse(readFileSync(path, 'utf8')) }
  }
  if (optional) return null
  throw new Error(`外部 ESM 依赖未安装：${name}（${parent}）`)
}

/** 读取外部平台包及必需平台依赖；第三方依赖由生产依赖图交付并按实际 import 核验。 */
function externalPackages(root) {
  const names = JSON.parse(
    readFileSync(resolve(root, 'scripts/release/mainExternalEsmPlatformPackages.json'), 'utf8')
  )
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    throw new Error('外部 ESM 包清单无效')
  const records = new Map()
  const load = (name, parent) => {
    const record = installedPackage(name, parent)
    const key = `${name}\0${record.root}`
    if (records.has(key)) return records.get(key)
    record.dependencies = []
    records.set(key, record)
    const required = new Set([
      ...Object.keys(record.manifest.dependencies ?? {}),
      ...Object.keys(record.manifest.peerDependencies ?? {}).filter(
        (dependency) => !record.manifest.peerDependenciesMeta?.[dependency]?.optional
      ),
    ])
    const bundled = record.manifest.bundledDependencies ?? record.manifest.bundleDependencies ?? []
    const bundledNames = new Set(bundled === true ? required : Array.isArray(bundled) ? bundled : [])
    for (const dependency of new Set([...required, ...bundledNames]))
      if (dependency.startsWith('@velaros-ai/') || bundledNames.has(dependency))
        record.dependencies.push(load(dependency, record.root))
    return record
  }
  return names.map((name) => load(name, root))
}

/** 按模块语法读取静态引用，字符串和注释不参与解析。 */
function staticImports(path, source) {
  const references = []
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  for (const node of file.statements)
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      references.push(node.moduleSpecifier.text)
  return references
}

/** 选择 Node ESM 实际启用的 exports/imports 条件分支。 */
function importTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(importTarget).find(Boolean)
  if (!value || typeof value !== 'object') return undefined
  for (const [condition, target] of Object.entries(value))
    if (condition === 'node' || condition === 'import' || condition === 'default') {
      const selected = importTarget(target)
      if (selected) return selected
    }
  return undefined
}

/** 解析精确导出和带星号的公开子路径。 */
function mappedTarget(map, key) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return importTarget(map)
  if (!Object.keys(map).some((entry) => entry.startsWith('.') || entry.startsWith('#')))
    return key === '.' ? importTarget(map) : undefined
  if (Object.hasOwn(map, key)) return importTarget(map[key])
  for (const pattern of Object.keys(map)
    .filter((entry) => entry.includes('*'))
    .sort((a, b) => b.length - a.length)) {
    const [prefix, suffix] = pattern.split('*')
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const target = importTarget(map[pattern])
    if (target) return target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length))
  }
  return undefined
}

/** 按发布清单列出平台包必须保留的代码和数据资源。 */
function packageFiles(record) {
  const result = new Set(['package.json'])
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '__pycache__' ||
        entry.name === '.DS_Store'
      )
        continue
      const relative = posix.join(prefix, entry.name)
      if (DevelopmentOnly.test(relative)) continue
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else if (entry.isFile() && !SourceOnly.test(relative)) result.add(relative)
    }
  }
  const publishedFiles = record.manifest.files ?? (
    record.name.startsWith('@velaros-ai/')
      ? ['dist']
      : [mappedTarget(record.manifest.exports, '.') ?? record.manifest.main ?? 'index.js']
  )
  for (const item of publishedFiles) {
    // 打包器可提升捆绑依赖；按 Node 解析路径单独校验包身份和资源。
    if (item === 'node_modules' || item.startsWith('node_modules/')) continue
    if (item.includes('*') || item.startsWith('!'))
      throw new Error(`外部平台包发布资源须有明确路径：${record.name} ${item}`)
    const path = resolve(record.root, item)
    if (!existsSync(path)) throw new Error(`外部平台包资源缺失：${record.name}/${item}`)
    if (statSync(path).isDirectory()) walk(path, item)
    else if (
      !SourceOnly.test(item) &&
      !DevelopmentOnly.test(item) &&
      !/^(?:README|CHANGELOG|LICENSE|NOTICE)(?:\.[^/]+)?$/iu.test(item)
    )
      result.add(item)
  }
  return [...result]
}

/** 在 ASAR 虚拟文件树内检查主入口 import、依赖版本及平台发布资源。 */
export function assertExternalEsmArchive({ root, entries, read }) {
  const files = new Set(entries)
  const manifests = new Map()
  const readManifest = (directory) => {
    const path = posix.join(directory, 'package.json')
    if (!files.has(path)) return undefined
    if (!manifests.has(path)) manifests.set(path, JSON.parse(read(path)))
    return manifests.get(path)
  }
  const findPackage = (name, origin) => {
    let directory = posix.dirname(origin)
    while (true) {
      const candidate = posix.join(directory, 'node_modules', name)
      if (files.has(posix.join(candidate, 'package.json'))) return candidate
      if (directory === '/') throw new Error(`app.asar 缺少运行依赖：${origin} -> ${name}`)
      directory = posix.dirname(directory)
    }
  }
  const requireFile = (path, origin, specifier) => {
    if (!files.has(path))
      throw new Error(`app.asar 模块入口或资源缺失：${origin} -> ${specifier}（${path}）`)
    return path
  }
  const resolveImport = (specifier, origin) => {
    if (HostModules.has(specifier) || isScriptRuntimeModule(specifier)) return
    if (specifier.startsWith('.'))
      return requireFile(posix.resolve(posix.dirname(origin), specifier), origin, specifier)
    if (specifier.startsWith('#')) {
      let directory = posix.dirname(origin)
      while (directory !== '/' && !readManifest(directory)) directory = posix.dirname(directory)
      const target = mappedTarget(readManifest(directory)?.imports, specifier)
      if (!target) throw new Error(`app.asar 包内 import 未声明：${origin} -> ${specifier}`)
      return target.startsWith('.')
        ? requireFile(posix.resolve(directory, target), origin, specifier)
        : resolveImport(target, origin)
    }
    const segments = specifier.split('/')
    const count = specifier.startsWith('@') ? 2 : 1
    const name = segments.slice(0, count).join('/')
    const subpath = segments.slice(count).join('/')
    const directory = findPackage(name, origin)
    const manifest = readManifest(directory)
    const target =
      manifest.exports === undefined
        ? subpath || manifest.main || 'index.js'
        : mappedTarget(manifest.exports, subpath ? `./${subpath}` : '.')
    if (!target) throw new Error(`app.asar 包未导出 ESM 入口：${origin} -> ${specifier}`)
    const path = posix.resolve(directory, target)
    const candidates =
      manifest.exports === undefined
        ? [path, `${path}.js`, `${path}.json`, posix.join(path, 'index.js')]
        : [path]
    return requireFile(
      candidates.find((candidate) => files.has(candidate)) ?? path,
      origin,
      specifier
    )
  }
  const visited = new Set()
  const visit = (record, origin) => {
    const directory = findPackage(record.name, origin)
    const manifest = readManifest(directory)
    if (manifest.name !== record.manifest.name || manifest.version !== record.manifest.version)
      throw new Error(
        `app.asar 外部依赖身份不匹配：${directory}，期望 ${record.manifest.name}@${record.manifest.version}`
      )
    if (visited.has(directory)) return
    visited.add(directory)
    for (const file of packageFiles(record)) {
      const path = requireFile(posix.join(directory, file), directory, file)
      if (CodeFile.test(file))
        for (const specifier of staticImports(path, read(path))) resolveImport(specifier, path)
    }
    for (const dependency of record.dependencies)
      visit(dependency, posix.join(directory, 'package.json'))
  }
  for (const record of externalPackages(root)) visit(record, '/package.json')
  for (const path of files)
    if (path.startsWith('/build/electron/main/') && CodeFile.test(path))
      for (const specifier of staticImports(path, read(path))) resolveImport(specifier, path)
  return visited.size
}
