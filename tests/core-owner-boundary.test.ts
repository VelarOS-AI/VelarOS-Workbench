import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '..')
const sourceRoots = [resolve(repositoryRoot, 'src')]
const sourceExtensions = new Set(['.ts', '.tsx'])

const removedCoreModules = new Set([
  '@velaros-ai/core/constants/storage',
  '@velaros-ai/core/constants/toolMetadataCatalog',
  '@velaros-ai/core/constants/workbenchViewport',
  '@velaros-ai/core/constants/workspaceSpaces',
  '@velaros-ai/core/constants/workspaceVisibility',
  '@velaros-ai/core/utils/CommandExecutionPolicy',
  '@velaros-ai/core/utils/PathContainmentHelper',
  '@velaros-ai/core/utils/PlatformCompatibilityHelper',
  '@velaros-ai/core/utils/messageFileChanges',
])

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

void describe('Core 0.3 owner boundary', () => {
  void test('never restores deleted product modules or concrete owner DTOs to Core', async () => {
    const failures: string[] = []

    for (const sourceRoot of sourceRoots) {
      for (const path of await collectSourceFiles(sourceRoot)) {
        const source = await readFile(path, 'utf8')
        const label = relative(repositoryRoot, path)

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

  void test('re-exports Browser, Model and Workspace contracts from their owners', async () => {
    const contracts = await readFile(
      resolve(repositoryRoot, 'src/shared/contracts/index.ts'),
      'utf8'
    )

    assert.match(
      contracts,
      /BrowserElementSelection[\s\S]*from '@velaros-ai\/browser\/core'/u
    )
    assert.match(
      contracts,
      /AgentProviderRuntimeConfig[\s\S]*ProviderModelCatalog[\s\S]*from '@velaros-ai\/model'/u
    )
    assert.match(
      contracts,
      /WorkspaceGitBranch[\s\S]*WorkspaceGitStatusResult[\s\S]*from '@velaros-ai\/workspace'/u
    )
  })

  void test('consumes cross-platform OS behavior through the browser-safe System owner', async () => {
    const sources = (
      await Promise.all(
        (await collectSourceFiles(resolve(repositoryRoot, 'src')))
          .map((path) => readFile(path, 'utf8'))
      )
    ).join('\n')

    assert.match(
      sources,
      /from '@velaros-ai\/system-tools\/platform-compatibility'/u
    )
    assert.doesNotMatch(sources, /from '@velaros-ai\/system-tools'/u)
    await assert.rejects(
      readFile(
        resolve(
          repositoryRoot,
          'src/utils/PlatformCompatibilityHelper.ts'
        ),
        'utf8'
      ),
      { code: 'ENOENT' }
    )
  })
})
