import { access, open, readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertExternalEsmArchive } from './externalEsmArchive.mjs'

const ProductFilename = 'VelarOS Workbench'
const packagedPlatforms = new Set(['darwin', 'win32', 'linux'])
const requiredLayoutRules = [
  /\.wb_filePanel\b[^{}]*\{[^}]*display:\s*flex/u,
  /\.wb_filePanelBody\b[^{}]*\{[^}]*display:\s*flex/u,
]

function archivePath(...segments) {
  return path.join(...segments)
}

function resolvePackagedWorkbenchPaths(appOutDir, platformName) {
  const resourcesRoot = platformName === 'darwin'
    ? path.join(appOutDir, `${ProductFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
  return {
    appArchive: path.join(resourcesRoot, 'app.asar'),
    resourcesRoot,
    typeScriptLibRoot: path.join(resourcesRoot, 'typescript', 'lib'),
  }
}

async function readWindowsExecutableArchitecture(executablePath) {
  const executable = await open(executablePath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    const dosRead = await executable.read(dosHeader, 0, dosHeader.length, 0)
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Packaged Workbench Windows executable has no valid DOS header: ${executablePath}`)
    }
    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(6)
    const peRead = await executable.read(peHeader, 0, peHeader.length, peOffset)
    if (peRead.bytesRead !== peHeader.length || peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Packaged Workbench Windows executable has no valid PE header: ${executablePath}`)
    }
    const machine = peHeader.readUInt16LE(4)
    if (machine === 0x8664) return 'x64'
    if (machine === 0xaa64) return 'arm64'
    if (machine === 0x014c) return 'ia32'
    throw new Error(
      `Packaged Workbench Windows executable has unsupported PE machine 0x${machine.toString(16)}.`
    )
  } finally {
    await executable.close()
  }
}

async function verifyWindowsX64Executable(appOutDir) {
  const executablePath = path.join(appOutDir, `${ProductFilename}.exe`)
  const architecture = await readWindowsExecutableArchitecture(executablePath)
  if (architecture !== 'x64') {
    throw new Error(
      `Packaged Workbench Windows executable architecture ${architecture} must equal x64.`
    )
  }
  return executablePath
}

async function waitForPackagedApp(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await access(filePath)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT' || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * 终端后端（@lydell/node-pty）必须以真文件解包：原生模块不能从 asar 里 dlopen，spawn-helper 要能 exec。
 * 每个包只装一个平台，包目录名就是平台；这里按包出来的 app 找它自己那个平台的二进制。
 */
async function verifyPackagedTerminalBackend(resourcesRoot, platformName) {
  const unpackedRoot = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@lydell')
  const entries = await readdir(unpackedRoot, { withFileTypes: true }).catch(() => [])
  const platformPackages = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`node-pty-${platformName}-`))
    .map((entry) => entry.name)
  if (platformPackages.length === 0) {
    throw new Error(`Packaged Workbench is missing the unpacked terminal backend for ${platformName}.`)
  }
  for (const packageName of platformPackages) {
    const target = packageName.slice('node-pty-'.length)
    const prebuildDir = path.join(unpackedRoot, packageName, 'prebuilds', target)
    await access(path.join(prebuildDir, 'pty.node')).catch(() => {
      throw new Error(`Packaged terminal backend is missing pty.node for ${target}.`)
    })
    if (platformName === 'win32') continue
    const helperPath = path.join(prebuildDir, 'spawn-helper')
    const helperStats = await stat(helperPath).catch(() => {
      throw new Error(`Packaged terminal backend is missing spawn-helper for ${target}.`)
    })
    if ((helperStats.mode & 0o111) === 0) {
      throw new Error(`Packaged terminal spawn-helper is not executable: ${helperPath}`)
    }
  }
}

async function verifyPackagedWorkbench({ appOutDir, platformName, projectDir = process.cwd() }) {
  const paths = resolvePackagedWorkbenchPaths(appOutDir, platformName)
  await waitForPackagedApp(paths.appArchive)
  if (platformName === 'win32') await verifyWindowsX64Executable(appOutDir)

  const workbenchPackage = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
  if (!workbenchPackage.version) throw new Error('Workbench version is missing')
  const rootRequire = createRequire(import.meta.url)
  const builderRequire = createRequire(rootRequire.resolve('electron-builder/package.json'))
  const { extractFile, listPackage } = builderRequire('@electron/asar')
  const packagedApp = JSON.parse(extractFile(paths.appArchive, archivePath('package.json')).toString('utf8'))
  if (packagedApp.version !== workbenchPackage.version) {
    throw new Error(
      `Packaged app version ${packagedApp.version ?? '<missing>'} `
      + `does not match expected ${workbenchPackage.version}.`
    )
  }

  const rendererHtml = extractFile(
    paths.appArchive,
    archivePath('build', 'electron', 'renderer', 'index.html')
  ).toString('utf8')
  const rendererCssHref = rendererHtml.match(/<link[^>]+href="\.\/([^"]+\.css)"[^>]*>/u)?.[1]
  if (!rendererCssHref) throw new Error('Packaged Workbench renderer CSS asset is missing.')
  const rendererCss = extractFile(
    paths.appArchive,
    archivePath('build', 'electron', 'renderer', rendererCssHref)
  ).toString('utf8')
  const rendererCssWithoutComments = rendererCss.replace(/\/\*[\s\S]*?\*\//gu, '')
  if (rendererCssWithoutComments.includes('@apply')) {
    throw new Error('Packaged Workbench renderer CSS still contains uncompiled Tailwind @apply rules.')
  }
  for (const requiredLayoutRule of requiredLayoutRules) {
    if (!requiredLayoutRule.test(rendererCss)) {
      throw new Error(`Packaged Workbench renderer CSS is missing ${requiredLayoutRule}.`)
    }
  }
  const workbenchRootRules = rendererCss.match(/\.wb_root\s*\{[^}]*\}/gu) ?? []
  if (workbenchRootRules.length !== 1 || /max-width\s*:/u.test(workbenchRootRules[0])) {
    throw new Error(
      'Packaged Workbench root is polluted by CSS Module class-name collisions from shared UI.'
    )
  }

  for (const bundledRuntimeFile of [
    'node_modules/pyright/package.json',
    'node_modules/pyright/langserver.index.js',
    'build/electron/main/workbench-language-worker.js',
    'build/electron/main/workbench-search-worker.js',
  ]) {
    const contents = extractFile(paths.appArchive, archivePath(...bundledRuntimeFile.split('/')))
    if (contents.length === 0)
      throw new Error(`Packaged app runtime file is empty: ${bundledRuntimeFile}`)
  }
  const languageWorker = extractFile(
    paths.appArchive,
    archivePath('build', 'electron', 'main', 'workbench-language-worker.js')
  ).toString('utf8')
  if (!languageWorker.includes('velarscript')) {
    throw new Error('Packaged Workbench language worker is missing the built-in Velar contribution.')
  }

  // 主进程在运行时从 node_modules 加载 Platform 的原生 ESM 包（脚本子进程入口、ScriptAct 模板都按包内路径
  // 解析）：按包的真实依赖与发布资源核对 asar 里每个静态 import 都能解析到。
  const archiveEntries = listPackage(paths.appArchive).map((entry) => ({
    path: entry.replaceAll('\\', '/'),
    lookupPath: entry.replace(/^[\\/]/u, ''),
  }))
  const archiveLookups = new Map(archiveEntries.map((entry) => [entry.path, entry.lookupPath]))
  const externalPackageCount = assertExternalEsmArchive({
    root: projectDir,
    entries: archiveEntries.map((entry) => entry.path),
    read: (entry) => extractFile(paths.appArchive, archiveLookups.get(entry)).toString('utf8'),
  })

  for (const excludedRuntime of ['node_modules/@anthropic-ai/claude-agent-sdk/package.json']) {
    try {
      extractFile(paths.appArchive, archivePath(...excludedRuntime.split('/')))
      throw new Error(`Packaged Workbench contains an excluded runtime: ${excludedRuntime}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Packaged Workbench contains')) {
        throw error
      }
    }
  }

  for (const trimmedTokenizerFile of [
    'node_modules/gpt-tokenizer/cjs/main.js',
    'node_modules/gpt-tokenizer/dist/o200k_base.js',
    'node_modules/gpt-tokenizer/src/main.ts',
    'node_modules/gpt-tokenizer/esm/bpeRanks/cl100k_base.js',
  ]) {
    try {
      extractFile(paths.appArchive, archivePath(...trimmedTokenizerFile.split('/')))
      throw new Error(`Packaged Workbench contains unused tokenizer data: ${trimmedTokenizerFile}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Packaged Workbench contains')) {
        throw error
      }
    }
  }

  await verifyPackagedTerminalBackend(paths.resourcesRoot, platformName)

  for (const standardLibraryFile of ['lib.d.ts', 'lib.es2022.full.d.ts']) {
    const filePath = path.join(paths.typeScriptLibRoot, standardLibraryFile)
    await access(filePath).catch(() => {
      throw new Error(`Packaged TypeScript standard library is missing: ${filePath}`)
    })
  }

  console.log(
    `Verified Workbench ${workbenchPackage.version} ${platformName} package runtime `
    + `(${externalPackageCount} external ESM packages): ${paths.appArchive}`
  )
}

async function findPackagedWorkbenchAppOutDir(releaseDir, expectedPlatformName = null) {
  if (expectedPlatformName && !packagedPlatforms.has(expectedPlatformName)) {
    throw new Error(`Unsupported packaged Workbench platform: ${expectedPlatformName}`)
  }
  const entries = await readdir(releaseDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const appOutDir = path.join(releaseDir, entry.name)
    const platformName = entry.name.startsWith('mac')
      ? 'darwin'
      : entry.name.startsWith('win')
        ? 'win32'
        : entry.name.startsWith('linux')
          ? 'linux'
          : null
    if (expectedPlatformName && platformName && platformName !== expectedPlatformName) continue
    const candidates = expectedPlatformName
      ? [expectedPlatformName]
      : platformName
        ? [platformName]
        : [...packagedPlatforms]
    for (const candidate of candidates) {
      const { appArchive } = resolvePackagedWorkbenchPaths(appOutDir, candidate)
      try {
        await access(appArchive)
        return { appOutDir, platformName: candidate }
      } catch {
        // 继续尝试其余平台布局。
      }
    }
  }
  throw new Error(`No unpacked Workbench app directory found in ${releaseDir}`)
}

export default async function afterPack(context) {
  await verifyPackagedWorkbench({
    appOutDir: context.appOutDir,
    platformName: context.electronPlatformName,
    projectDir: context.packager.info.projectDir,
  })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const releaseDir = path.resolve(process.cwd(), process.argv[2] ?? 'artifacts/desktop')
  await verifyPackagedWorkbench(
    await findPackagedWorkbenchAppOutDir(releaseDir, process.argv[3] ?? null)
  )
}

export {
  archivePath,
  findPackagedWorkbenchAppOutDir,
  readWindowsExecutableArchitecture,
  requiredLayoutRules,
  resolvePackagedWorkbenchPaths,
  verifyPackagedWorkbench,
  verifyWindowsX64Executable,
}
