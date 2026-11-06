import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { test } from 'bun:test'

import { NodeDefaultPackages } from '@velaros-ai/velaros/script'

import { assertNodeRuntimePackageFiles } from '../scripts/release/nodeRuntimePackages.mjs'
import WorkbenchNodePackages from '../src/main/conversation/workbenchNodePackages.json' with { type: 'json' }

test('Workbench owns its code libraries and verifies every declared resource without weakening integrity checks', async () => {
  assert.equal(NodeDefaultPackages.includes('prettier'), false)
  assert(WorkbenchNodePackages.includes('prettier'))
  assert(WorkbenchNodePackages.includes('typescript'))
  const parent = tmpdir()
  const root = await mkdtemp(join(parent, 'workbench-runtime-manifest-'))
  try {
    const packages = {}
    const files = {}
    for (const name of new Set([...NodeDefaultPackages, ...WorkbenchNodePackages])) {
      packages[name] = '1.0.0'
      const relative = `node_modules/${name}/package.json`
      const content = JSON.stringify({ name, version: packages[name] })
      await mkdir(dirname(join(root, relative)), { recursive: true })
      await writeFile(join(root, relative), content)
      files[relative] = createHash('sha256').update(content).digest('hex')
    }
    const manifestPath = join(root, 'manifest.json')
    const manifest = { packages, files, installers: { npm: '1.0.0' } }
    await writeFile(manifestPath, JSON.stringify(manifest))
    assert.deepEqual((await assertNodeRuntimePackageFiles(root)).packages, packages)
    const packagePath = join(root, 'node_modules/prettier/package.json')
    const original = await readFile(packagePath, 'utf8')
    await writeFile(packagePath, `${original}\n`)
    await assert.rejects(assertNodeRuntimePackageFiles(root), /文件缺失、增加或被改动/u)
    await writeFile(packagePath, original)
    delete manifest.packages.prettier
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(assertNodeRuntimePackageFiles(root), { code: 'ERR_ASSERTION' })
  } finally {
    assert.equal(dirname(root), parent)
    await rm(root, { recursive: true, force: true })
  }
})
