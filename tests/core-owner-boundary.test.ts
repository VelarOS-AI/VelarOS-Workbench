import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

import { describe, test } from 'bun:test'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceRoots = [resolve(repositoryRoot, 'src')]
const sourceExtensions = new Set(['.ts', '.tsx'])

const removedCoreModules = new Set([
  '@velaros-ai/core/utils/CommandExecutionPolicy',
  '@velaros-ai/core/utils/PathContainmentHelper',
  '@velaros-ai/core/utils/PlatformCompatibilityHelper',
  '@velaros-ai/core/utils/messageFileChanges',
])

/**
 * 已退役的 Platform 属主。它们的零件各有新家：项目与命令在 `@velaros-ai/velaros/project`、
 * `@velaros-ai/velaros/execution`，浏览器在 `@velaros-ai/velaros/browser/...`，跨平台行为在
 * `@velaros-ai/core/platform`，对话数据在 `@velaros-ai/ui/conversation/contracts`。
 */
const retiredOwnerModules = [
  /^@velaros-ai\/(?:browser|development|project|system|system-tools)(?:\/|$)/u,
  /^@velaros-ai\/agent\/(?:protocol|tool-contract)(?:\/|$)/u,
]

/** 外来合同数据类型的唯一属主。 */
const contractOwners: Readonly<Record<string, readonly string[]>> = {
  AppLocale: ['@velaros-ai/ui/conversation/contracts'],
  ChatMessage: ['@velaros-ai/ui/conversation/contracts'],
  ContentBlock: ['@velaros-ai/ui/conversation/contracts'],
  ToolCallBlock: ['@velaros-ai/ui/conversation/contracts'],
  BrowserElementSelection: ['@velaros-ai/velaros/browser/contracts'],
  AgentProviderRuntimeConfig: ['@velaros-ai/model', '@velaros-ai/model/contracts'],
  ListProviderModelsRequest: ['@velaros-ai/model', '@velaros-ai/model/contracts'],
  ProviderModelCatalog: ['@velaros-ai/model', '@velaros-ai/model/contracts'],
}

const concreteOwnerNames = new Set([
  'AgentProviderRuntimeConfig',
  'BrowserElementSelection',
  'ListProviderModelsRequest',
  'ProviderModelCatalog',
  'WorkspaceSpaceKind',
])

function isConcreteOwnerName(name: string): boolean {
  return (
    name.startsWith('Workbench')
    || name.startsWith('System')
    || name.startsWith('WorkspaceGit')
    || name.startsWith('AuxiliaryModel')
    || concreteOwnerNames.has(name)
  )
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectSourceFiles(path))
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

function importedNames(clause: string): string[] {
  return clause
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
}

/** 静态导入、再导出、动态导入与副作用导入里的 `@velaros-ai/*` 模块名。 */
function velarosSpecifiers(source: string): string[] {
  return [...source.matchAll(
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](@velaros-ai\/[^'"]+)['"]/gu
  )].map((match) => match[1]!)
}

function repositoryPath(path: string): string {
  return relative(repositoryRoot, path).replaceAll('\\', '/')
}

void describe('Core 0.4 owner boundary', () => {
  void test('never restores deleted product modules or concrete owner DTOs to Core', async () => {
    const failures: string[] = []

    for (const sourceRoot of sourceRoots) {
      for (const path of await collectSourceFiles(sourceRoot)) {
        const source = await readFile(path, 'utf8')
        const label = repositoryPath(path)

        for (const match of source.matchAll(
          /(?:from\s+|import\s*\()\s*['"](@velaros-ai\/core[^'"]*)['"]/gu
        )) {
          const specifier = match[1]
          if (specifier && removedCoreModules.has(specifier)) {
            failures.push(`${label} imports deleted Core module ${specifier}`)
          }
        }

        for (const match of source.matchAll(
          /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core(?:\/types)?['"]/gu
        )) {
          for (const name of importedNames(match[1] ?? '')) {
            if (isConcreteOwnerName(name)) {
              failures.push(`${label} imports concrete ${name} from Core`)
            }
          }
        }
      }
    }

    assert.deepEqual(failures, [])
  })

  void test('imports nothing from the retired Platform owners', async () => {
    const failures: string[] = []

    for (const sourceRoot of sourceRoots) {
      for (const path of await collectSourceFiles(sourceRoot)) {
        const source = await readFile(path, 'utf8')
        for (const specifier of velarosSpecifiers(source)) {
          if (retiredOwnerModules.some((pattern) => pattern.test(specifier))) {
            failures.push(`${repositoryPath(path)} imports retired owner ${specifier}`)
          }
        }
      }
    }

    assert.deepEqual(failures, [])
  })

  void test('imports chat, Browser and Model contracts directly from their owners', async () => {
    const observed = new Set<string>()
    for (const path of await collectSourceFiles(resolve(repositoryRoot, 'src'))) {
      const source = await readFile(path, 'utf8')
      for (const match of source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gu
      )) {
        for (const name of importedNames(match[1] ?? '')) {
          const owner = contractOwners[name]
          if (!owner) continue
          assert.ok(owner.includes(match[2]!), `${repositoryPath(path)}: ${name} from ${match[2]}`)
          observed.add(name)
        }
      }
    }
    assert.ok(observed.has('ChatMessage'))
    assert.ok(observed.has('BrowserElementSelection'))
    assert.ok(observed.has('AgentProviderRuntimeConfig'))
  })

  void test('owns the Git contracts in one Workbench file', async () => {
    // Platform 的项目能力不再带 Git 合同：Workbench 的 Git 服务与面板是唯一的生产方和消费方，定义只在这一处。
    const owner = 'src/shared/contracts/workspaceGit.ts'
    const declaredIn = new Map<string, string[]>()
    for (const path of await collectSourceFiles(resolve(repositoryRoot, 'src'))) {
      const source = await readFile(path, 'utf8')
      for (const match of source.matchAll(
        /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+(WorkspaceGit\w+)\b|type\s+(WorkspaceGit\w+)\s*(?:<[^>]*>)?\s*=)/gmu
      )) {
        const name = match[1] ?? match[2]!
        declaredIn.set(name, [...(declaredIn.get(name) ?? []), repositoryPath(path)])
      }
    }

    assert.ok(declaredIn.has('WorkspaceGitStatusResult'))
    for (const [name, files] of declaredIn) assert.deepEqual(files, [owner], name)
  })

  void test('consumes cross-platform OS behavior through the Core platform owner', async () => {
    const files = await collectSourceFiles(resolve(repositoryRoot, 'src'))
    const sources = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n')

    assert.match(sources, /from '@velaros-ai\/core\/platform'/u)
    // 不留本地的兼容层副本：平台判断只有 Core 这一份。
    assert.deepEqual(
      files.filter((path) => /PlatformCompatibility/u.test(basename(path))).map(repositoryPath),
      []
    )
  })
})
