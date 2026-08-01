import { access, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const releaseDir = path.resolve(process.cwd(), process.argv[2] ?? 'release')
const entries = await readdir(releaseDir, { withFileTypes: true })
const appDirectory = entries.find((entry) =>
  entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
if (!appDirectory) throw new Error(`No unpacked mac app directory found in ${releaseDir}`)

const appRoot = path.join(
  releaseDir,
  appDirectory.name,
  'VelarOS Workbench.app',
  'Contents',
  'Resources',
  'app.asar'
)

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

await waitForPackagedApp(appRoot)
const appPackage = JSON.parse(
  await readFile(path.resolve('apps/workbench/package.json'), 'utf8')
)
if (!appPackage.version) throw new Error('Workbench app version is missing')
const rootRequire = createRequire(import.meta.url)
const builderRequire = createRequire(rootRequire.resolve('electron-builder/package.json'))
const { extractFile } = builderRequire('@electron/asar')
const packagedApp = JSON.parse(extractFile(appRoot, 'package.json').toString('utf8'))
if (packagedApp.version !== appPackage.version) {
  throw new Error(
    `Packaged app version ${packagedApp.version ?? '<missing>'} `
    + `does not match expected ${appPackage.version}.`
  )
}
for (const bundledRuntimeFile of [
  'node_modules/pyright/package.json',
  'node_modules/pyright/langserver.index.js',
  'out/main/workbench-language-worker.js',
]) {
  const contents = extractFile(appRoot, bundledRuntimeFile)
  if (contents.length === 0)
    throw new Error(`Packaged app runtime file is empty: ${bundledRuntimeFile}`)
}
const languageWorker = extractFile(appRoot, 'out/main/workbench-language-worker.js').toString('utf8')
if (!languageWorker.includes('velarscript')) {
  throw new Error('Packaged Workbench language worker is missing the built-in Velar contribution.')
}
console.log(
  `Verified unsigned packaged app ${appPackage.version} with bundled Pyright and built-in Velar support: ${appRoot}`
)
