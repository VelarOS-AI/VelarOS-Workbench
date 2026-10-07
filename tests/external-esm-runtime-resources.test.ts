import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { assertExternalEsmArchive } from '../scripts/release/externalEsmArchive.mjs'

test('production resources exclude compiled acceptance tests and still reject runtime imports of them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-esm-resources-'))
  try {
    const directory = join(root, 'node_modules/@velaros-ai/proof')
    await mkdir(join(directory, 'dist/test'), { recursive: true })
    await mkdir(join(root, 'scripts/release'), { recursive: true })
    await writeFile(
      join(root, 'scripts/release/mainExternalEsmPlatformPackages.json'),
      '["@velaros-ai/proof"]'
    )
    const manifest = JSON.stringify({
      name: '@velaros-ai/proof',
      version: '1.0.0',
      files: ['dist'],
      exports: { '.': './dist/index.js' },
    })
    await writeFile(join(directory, 'package.json'), manifest)
    await writeFile(join(directory, 'dist/index.js'), 'export const product=true')
    await writeFile(
      join(directory, 'dist/test/acceptance.test.js'),
      "import {test} from 'bun:test'"
    )
    const files = new Map([
      ['/package.json', '{}'],
      ['/node_modules/@velaros-ai/proof/package.json', manifest],
      ['/node_modules/@velaros-ai/proof/dist/index.js', 'export const product=true'],
    ])
    const validate = () =>
      assertExternalEsmArchive({
        root,
        entries: [...files.keys()],
        read: (path: string) => files.get(path)!,
      })
    expect(validate()).toBe(1)
    files.set('/node_modules/@velaros-ai/proof/dist/index.js', "import './test/acceptance.test.js'")
    expect(validate).toThrow('模块入口或资源缺失')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
