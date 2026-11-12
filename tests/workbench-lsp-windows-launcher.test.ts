import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'bun:test'

import { ExternalLspClient } from '../src/main/workspace/language/ExternalLspClient'
import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'

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
