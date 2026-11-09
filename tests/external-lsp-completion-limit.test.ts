import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'bun:test'

import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import {
  type WorkbenchLanguagePathResolver,
  WorkbenchLanguageServices,
} from '../src/main/workspace/language/LanguageServices'
import { ProjectToolWorkerHost } from '../src/main/workspace/language/ProjectToolWorkerHost'
import { registerWorkbenchLanguageService } from '../src/shared/workbenchLanguageServices'

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const languagePathResolver: WorkbenchLanguagePathResolver = {
  async resolveProjectRoot(input) {
    const root = await realpath(resolve(input))
    if (!(await stat(root)).isDirectory()) throw new Error('The language project root must be a directory')
    return root
  },
  assertAllowedProjectPath(projectRoot, absolutePath, inputPath) {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot, absolutePath) {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot, absolutePath) {
    const value = relative(projectRoot, absolutePath)
    if (!isInside(projectRoot, absolutePath))
      throw new Error(`Language path escapes the project: ${absolutePath}`)
    return (value || '.').replaceAll('\\', '/')
  },
}

void test('retains large contextual completion rosters within a safe external LSP bound', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'workbench-many-completions-'))
  const remove = registerWorkbenchLanguageService({
    id: 'many-completions-fixture',
    label: 'Many Completions Fixture',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['many-completions'],
    languages: ['many-completions'],
    command: process.execPath,
    args: [fixture, 'many-completions'],
    documentLanguageId: 'many-completions',
  })
  const services = new WorkbenchLanguageServices(
    languagePathResolver,
    new ExternalLspProcessHost(),
    new ProjectToolWorkerHost(
      new URL('../src/main/workspace/language/ProjectToolWorker.ts', import.meta.url)
    )
  )

  try {
    const result = await services.getCompletions({
      projectRoot,
      path: 'main.many-completions',
      content: '',
      position: { line: 1, column: 1 },
    })

    assert.equal(result.items.length, 512)
    // 截掉了一部分：编辑器继续输入时要重新请求，不能只在这 512 项里筛。
    assert.equal(result.isIncomplete, true)
    assert.equal(result.items[0]?.label, 'lookProperty000')
    assert.equal(result.items[224]?.label, 'lookProperty224')
    assert.equal(result.items[511]?.label, 'lookProperty511')
    assert.ok(!result.items.some((item) => item.label === 'lookProperty512'))
  } finally {
    await services.dispose()
    remove()
    await rm(projectRoot, { recursive: true, force: true })
  }
})
