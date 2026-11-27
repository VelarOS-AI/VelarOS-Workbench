import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { test } from 'bun:test'

import { ExternalLspClient } from '../src/main/workspace/language/ExternalLspClient'
import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import { WorkbenchLanguageServiceWorkerClient } from '../src/main/workspace/language/LanguageServiceWorkerClient'

test.skipIf(process.platform !== 'win32')(
  'Windows SDK batch launchers work from paths with spaces',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-sdk-launcher-'))
    const directory = join(root, 'SDK with spaces')
    await mkdir(directory)
    const command = join(directory, 'sdk.bat')
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`)
    const processes = new ExternalLspProcessHost()
    const client = new ExternalLspClient(processes, root, {
      id: 'batch-sdk',
      label: 'Batch SDK',
      installKind: 'builtin',
      runtime: 'lsp-server',
      extensions: ['sdk'],
      languages: ['sdk'],
      command,
    })
    try {
      const result = await client.completion(join(root, 'main.sdk'), 'comp', {
        line: 0,
        character: 4,
      })
      assert.equal(result.items[0]?.label, 'component')
    } finally {
      await client.dispose()
      await processes.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

test.skipIf(process.platform !== 'win32')(
  'the language worker finds C# on Windows Path with mixed-case environment keys',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-csharp-path-'))
    const projectRoot = join(root, 'project')
    const tools = join(root, 'SDK with spaces')
    const content = 'comp'
    const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.cjs', import.meta.url))
    await Promise.all([mkdir(projectRoot), mkdir(tools)])
    await Promise.all([
      writeFile(join(projectRoot, 'Program.cs'), content),
      writeFile(
        join(tools, 'csharp-ls.cmd'),
        `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
      ),
      writeFile(join(tools, 'csharp-ls.bat'), '@echo off\r\nexit /b 1\r\n'),
    ])
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !['PATH', 'PATHEXT'].includes(key.toUpperCase())
      )
    )
    env.Path = [tools, process.env.PATH].join(delimiter)
    env.PathExt = '.CMD;.BAT;.EXE'
    const client = new WorkbenchLanguageServiceWorkerClient(
      (options) =>
        new Worker(
          new URL('../src/main/workspace/language/LanguageServiceWorker.ts', import.meta.url),
          { env, workerData: options, transferList: [options.processPort] }
        )
    )
    try {
      const result = await client.getCompletions({
        projectRoot,
        path: 'Program.cs',
        language: 'csharp',
        content,
        position: { line: 1, column: 5 },
      })
      assert.equal(result.items[0]?.label, 'component')
    } finally {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000
)
