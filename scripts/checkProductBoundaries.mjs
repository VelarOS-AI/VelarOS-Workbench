import { access, readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoots = [resolve(rootDir, 'src')]
const sourceExtensions = new Set(['.ts', '.tsx', '.css'])
const forbiddenSpecifiers = [
  /^@velaros-ai\/velaros\/(?:browser|web|sessions|project|images|office|computer|skills|sandbox|features|act\/bridge)(?:\/|$)/,
  /^@velaros-ai\/(?:core|model|agent|kernel|context|script|skill-jsts)(?:\/|$)/,
  /^apps\/desktop(?:\/|$)/,
  /^@(?:components|hooks|runtime)\//,
  /^@velaros-ai\/workbench(?:\/|$)/,
  /^@workbench-velar(?:\/|$)/,
  /VelarOS-Desktop/,
  /^@velaros-ai\/velaros\/core\/constants\/(?:storage|toolMetadataCatalog|workbenchViewport|workspaceSpaces|workspaceVisibility)$/,
  /^@velaros-ai\/velaros\/core\/utils\/(?:CommandExecutionPolicy|PathContainmentHelper|PlatformCompatibilityHelper|messageFileChanges)$/,
  /^@velaros-ai\/system-tools$/,
  /^@anthropic-ai\/claude-agent-sdk(?:\/|$)/,
]
const importSpecifierPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu
const coreNamedImportPattern =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/velaros\/core(?:\/types)?['"]/gu
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
  return layerRules.find(({ prefix }) => label.startsWith(prefix))
}

/**
 * 进程边界只看仓库自己的源码：相对路径与 `@main/`、`@renderer/`、`@shared/` 别名。包的子路径另有含义，
 * 例如 `@velaros-ai/velaros/renderer` 是把 Act 事件投影成展示数据的纯函数，主进程与 Desktop 一样直接用。
 */
function isRepositorySpecifier(specifier) {
  return specifier.startsWith('.') || /^@(?:main|renderer|shared)\//u.test(specifier)
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
const rootManifest = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))
for (const section of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  if (rootManifest[section]?.['@anthropic-ai/claude-agent-sdk']) {
    failures.push(
      `package.json ${section} bundles Claude Agent SDK; Workbench drives the user's installed claude CLI over its stream-json protocol instead.`
    )
  }
}
for (const sourceRoot of sourceRoots) {
  for (const path of await collectSourceFiles(sourceRoot)) {
    const source = await readFile(path, 'utf8')
    const label = relative(rootDir, path).replaceAll('\\', '/')
    if (extname(path) === '.css') {
      if (!label.startsWith('src/renderer/src/styles/')) {
        failures.push(`${label}: 应用 CSS 必须集中在 src/renderer/src/styles/。`)
      }
      continue
    }
    const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    if (
      syntax.statements.length > 0 &&
      syntax.statements.every(
        (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier
      )
    ) {
      failures.push(`${label}: 纯转发文件应移除，消费方直接导入实现或包的公开入口。`)
    }
    if (label.startsWith('src/main/')) {
      if (/new\s+KernelModuleHost\s*\(/u.test(source)) {
        failures.push(
          `${label} constructs KernelModuleHost; complete hosts must compose the public Kernel.`
        )
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
      if (
        isRepositorySpecifier(specifier) &&
        layerRule?.forbidden.some((pattern) => pattern.test(specifier))
      ) {
        failures.push(`${label} crosses its process boundary through "${specifier}"`)
      }
    }
    for (const match of source.matchAll(coreNamedImportPattern)) {
      const concrete = match[1].match(forbiddenCoreContractPattern)?.[0]
      if (concrete) {
        failures.push(`${relative(rootDir, path)} imports product contract "${concrete}" from Core`)
      }
    }
  }
}

const allowedSourceDirectories = new Set(['main', 'preload', 'renderer', 'shared'])
for (const entry of await readdir(resolve(rootDir, 'src'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !allowedSourceDirectories.has(entry.name)) {
    failures.push(`src/${entry.name}: 单体源码根只允许 main、preload、renderer、shared 四层。`)
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
