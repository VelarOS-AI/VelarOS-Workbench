import { access, readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoots = [resolve(rootDir, 'src')]
const sourceExtensions = new Set(['.ts', '.tsx'])
const forbiddenSpecifiers = [
  /^apps\/desktop(?:\/|$)/,
  /^@(?:components|hooks|runtime)\//,
  /^@velaros-ai\/workbench(?:\/|$)/,
  /^@workbench-velar(?:\/|$)/,
  /VelarOS-Desktop/,
  /^@velaros-ai\/core\/constants\/(?:storage|toolMetadataCatalog|workbenchViewport|workspaceSpaces|workspaceVisibility)$/,
  /^@velaros-ai\/core\/utils\/(?:CommandExecutionPolicy|PathContainmentHelper|PlatformCompatibilityHelper|messageFileChanges)$/,
  /^@velaros-ai\/system-tools$/,
]
const importSpecifierPattern =
  /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu
const coreNamedImportPattern =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core(?:\/types)?['"]/gu
const forbiddenCoreContractPattern =
  /\b(?:Workbench\w+|SystemWorkspace\w+|BrowserElementSelection|AgentProviderRuntimeConfig|AuxiliaryModel\w+|ListProviderModelsRequest|ProviderModelCatalog)\b/u
const layerRules = [
  {
    prefix: 'src/main/',
    forbidden: [/^@renderer\//, /(?:^|\/)renderer(?:\/|$)/],
  },
  {
    prefix: 'src/preload/',
    forbidden: [/^@main\//, /^@renderer\//, /(?:^|\/)(?:main|renderer)(?:\/|$)/],
  },
  {
    prefix: 'src/renderer/',
    forbidden: [/^@main\//, /(?:^|\/)main(?:\/|$)/],
  },
  {
    prefix: 'src/shared/',
    forbidden: [/^@main\//, /^@renderer\//, /(?:^|\/)(?:main|renderer)(?:\/|$)/],
  },
]

function resolveLayerRule(label) {
  const fixedRule = layerRules.find(({ prefix }) => label.startsWith(prefix))
  if (fixedRule) return fixedRule

  const pluginLayer = label.match(/^src\/plugins\/[^/]+\/(main|renderer)(?:\/|$)/u)?.[1]
  if (pluginLayer === 'main') {
    return { forbidden: [/^@renderer\//, /(?:^|\/)renderer(?:\/|$)/] }
  }
  if (pluginLayer === 'renderer') {
    return { forbidden: [/^@main\//, /(?:^|\/)main(?:\/|$)/] }
  }
  if (label.startsWith('src/plugins/')) {
    return {
      forbidden: [/^@main\//, /^@renderer\//, /(?:^|\/)(?:main|renderer)(?:\/|$)/],
    }
  }
  return undefined
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)))
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path)
  }

  return files
}

const failures = []
for (const sourceRoot of sourceRoots) {
  for (const path of await collectSourceFiles(sourceRoot)) {
    const source = await readFile(path, 'utf8')
    const label = relative(rootDir, path)
    if (label.startsWith('src/main/')) {
      if (/new\s+KernelModuleHost\s*\(/u.test(source)) {
        failures.push(`${label} constructs KernelModuleHost; complete hosts must compose the public Kernel.`)
      }
      if (/class\s+\w*KernelRuntime\b/u.test(source)) {
        failures.push(`${label} recreates a product Kernel runtime facade.`)
      }
      if (/\bsafeStorage\b/u.test(source)) {
        failures.push(`${label} uses Electron safeStorage; use app-local credential storage.`)
      }
    }
    const layerRule = resolveLayerRule(label)
    for (const match of source.matchAll(importSpecifierPattern)) {
      const specifier = match[1]
      if (forbiddenSpecifiers.some((pattern) => pattern.test(specifier))) {
        failures.push(`${label} imports forbidden dependency "${specifier}"`)
      }
      if (layerRule?.forbidden.some((pattern) => pattern.test(specifier))) {
        failures.push(`${label} crosses its process boundary through "${specifier}"`)
      }
    }
    for (const match of source.matchAll(coreNamedImportPattern)) {
      const concrete = match[1].match(forbiddenCoreContractPattern)?.[0]
      if (concrete) {
        failures.push(
          `${relative(rootDir, path)} imports product contract "${concrete}" from Core`
        )
      }
    }
  }
}

const allowedSourceDirectories = new Set(['main', 'plugins', 'preload', 'renderer', 'shared'])
for (const entry of await readdir(resolve(rootDir, 'src'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !allowedSourceDirectories.has(entry.name)) {
    failures.push(
      `src/${entry.name}: 单体源码根只允许 main、plugins、preload、renderer、shared 五层。`
    )
  }
}

try {
  await access(resolve(rootDir, 'packages'))
  failures.push('packages/: 单体 Workbench 不得恢复 package workspace。')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

try {
  await access(resolve(rootDir, 'apps'))
  failures.push('apps/: 仓库本身就是 Workbench，不得再增加应用套层。')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (failures.length > 0) {
  console.error('Workbench product boundary check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Workbench product boundary check passed.')
}
