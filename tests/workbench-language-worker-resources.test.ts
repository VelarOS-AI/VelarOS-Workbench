import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { test } from 'bun:test'

import { WorkbenchLanguageServiceWorkerClient } from '../src/main/workspace/language/LanguageServiceWorkerClient'

test('language workers use the standard library shipped outside the application archive', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wb-language-resources-')))
  const projectRoot = join(directory, 'project')
  const resourcesPath = join(directory, 'resources')
  const libraries = join(resourcesPath, 'typescript', 'lib')
  const content = 'packagedConsole.\n'
  await mkdir(projectRoot)
  await mkdir(libraries, { recursive: true })
  await Promise.all([
    writeFile(join(projectRoot, 'main.ts'), content),
    writeFile(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ESNext', strict: true },
        include: ['*.ts'],
      })
    ),
    writeFile(
      join(libraries, 'lib.esnext.full.d.ts'),
      [
        'interface Array<T> { length: number }',
        'interface Boolean {}',
        'interface CallableFunction {}',
        'interface Function {}',
        'interface IArguments {}',
        'interface NewableFunction {}',
        'interface Number {}',
        'interface Object {}',
        'interface RegExp {}',
        'interface String {}',
        'declare const packagedConsole: { log(message: string): void }',
      ].join('\n')
    ),
  ])
  const client = new WorkbenchLanguageServiceWorkerClient(
    (options) =>
      new Worker(
        new URL('../src/main/workspace/language/LanguageServiceWorker.ts', import.meta.url),
        { workerData: { ...options, resourcesPath }, transferList: [options.processPort] }
      )
  )
  try {
    const request = { projectRoot, path: 'main.ts', language: 'typescript', content }
    const completions = await client.getCompletions({
      ...request,
      position: { line: 1, column: content.indexOf('.') + 2 },
    })
    assert.ok(completions.items.some((item) => item.label === 'log'))
    const hover = await client.getHover({ ...request, position: { line: 1, column: 4 } })
    assert.match(hover.hover?.displayText ?? '', /packagedConsole/)
    assert.match(hover.hover?.displayText ?? '', /log\(message: string\)/)
  } finally {
    await client.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
