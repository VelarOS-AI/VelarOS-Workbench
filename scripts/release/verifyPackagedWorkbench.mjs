import { access, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ProductFilename = 'VelarOS Workbench'

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

async function verifyPackagedWorkbench({ appOutDir, platformName }) {
  const paths = resolvePackagedWorkbenchPaths(appOutDir, platformName)
  await waitForPackagedApp(paths.appArchive)

  const workbenchPackage = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'))
  if (!workbenchPackage.version) throw new Error('Workbench version is missing')
  const rootRequire = createRequire(import.meta.url)
  const builderRequire = createRequire(rootRequire.resolve('electron-builder/package.json'))
  const { extractFile } = builderRequire('@electron/asar')
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
  for (const requiredLayoutRule of [
    /\.wb_filePanel\s*\{[^}]*display:\s*flex/u,
    /\.wb_filePanelBody\s*\{[^}]*display:\s*flex/u,
  ]) {
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

  for (const excludedRuntime of [
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    'node_modules/@velaros-ai/agent/package.json',
  ]) {
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

  for (const standardLibraryFile of ['lib.d.ts', 'lib.es2022.full.d.ts']) {
    const filePath = path.join(paths.typeScriptLibRoot, standardLibraryFile)
    await access(filePath).catch(() => {
      throw new Error(`Packaged TypeScript standard library is missing: ${filePath}`)
    })
  }

  console.log(
    `Verified Workbench ${workbenchPackage.version} ${platformName} package runtime: ${paths.appArchive}`
  )
}

async function findPackagedWorkbenchAppOutDir(releaseDir) {
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
    const candidates = platformName ? [platformName] : ['darwin', 'win32', 'linux']
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
  })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const releaseDir = path.resolve(process.cwd(), process.argv[2] ?? 'artifacts/desktop')
  await verifyPackagedWorkbench(await findPackagedWorkbenchAppOutDir(releaseDir))
}

export {
  archivePath,
  findPackagedWorkbenchAppOutDir,
  resolvePackagedWorkbenchPaths,
  verifyPackagedWorkbench,
}
