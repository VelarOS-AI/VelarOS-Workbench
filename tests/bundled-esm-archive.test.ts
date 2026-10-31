import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import {
  assertExternalEsmArchive,
  installedPackage,
} from '../scripts/release/externalEsmArchive.mjs'

test('bundled runtime dependencies retain their identity and resources after hoisting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-bundled-esm-'))
  try {
    const owner = join(root, 'node_modules/@velaros-ai/proof')
    const bundled = join(owner, 'node_modules/bundled-runtime')
    await mkdir(join(owner, 'dist'), { recursive: true })
    await mkdir(bundled, { recursive: true })
    await mkdir(join(root, 'scripts/release'), { recursive: true })
    await writeFile(
      join(root, 'scripts/release/mainExternalEsmPlatformPackages.json'),
      '["@velaros-ai/proof"]'
    )
    const ownerManifest = JSON.stringify({
      name: '@velaros-ai/proof',
      version: '1.0.0',
      files: ['dist', 'node_modules'],
      exports: './dist/index.js',
      dependencies: { 'bundled-runtime': '2.0.0' },
      bundledDependencies: ['bundled-runtime'],
    })
    const bundleManifest = JSON.stringify({
      name: 'bundled-runtime',
      version: '2.0.0',
      files: ['index.js', 'data.json'],
      exports: './index.js',
    })
    await writeFile(join(owner, 'package.json'), ownerManifest)
    await writeFile(join(owner, 'dist/index.js'), "import 'bundled-runtime'")
    await writeFile(join(bundled, 'package.json'), bundleManifest)
    await writeFile(join(bundled, 'index.js'), 'export const value=1')
    await writeFile(join(bundled, 'data.json'), '{}')
    for (const bundlePath of [
      '/node_modules/bundled-runtime',
      '/node_modules/@velaros-ai/proof/node_modules/bundled-runtime',
    ]) {
      const files = new Map([
        ['/package.json', '{}'],
        ['/node_modules/@velaros-ai/proof/package.json', ownerManifest],
        ['/node_modules/@velaros-ai/proof/dist/index.js', "import 'bundled-runtime'"],
        [`${bundlePath}/package.json`, bundleManifest],
        [`${bundlePath}/index.js`, 'export const value=1'],
        [`${bundlePath}/data.json`, '{}'],
      ])
      const validate = () =>
        assertExternalEsmArchive({
          root,
          entries: [...files.keys()],
          read: (file: string) => files.get(file)!,
        })
      assert.equal(validate(), 2)
      files.delete(`${bundlePath}/data.json`)
      assert.throws(validate, /模块入口或资源缺失/u)
      files.set(`${bundlePath}/data.json`, '{}')
      files.set(`${bundlePath}/package.json`, bundleManifest.replace('2.0.0', '1.0.0'))
      assert.throws(validate, /外部依赖身份不匹配/u)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npm packages named like Node builtins remain discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-npm-builtin-'))
  try {
    const packageRoot = join(root, 'node_modules', 'assert')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'assert', version: '2.1.0' })
    )
    assert.equal(installedPackage('assert', root).manifest.version, '2.1.0')
    assert.equal(installedPackage('missing-workbench-package', root, true), null)
    assert.throws(() => installedPackage('missing-workbench-package', root), /依赖未安装/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
