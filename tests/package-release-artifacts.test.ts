import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  createPackageReleaseManifest,
  packUniqueTarball,
  validatePackageReleaseManifest,
} from '../scripts/release/publish-packages.mjs'

const packageManifest = {
  name: '@velaros-ai/workbench',
  version: '0.3.0',
}
const sourceSha = 'b'.repeat(40)
const releaseTag = 'v0.3.0'

void describe('Workbench package release artifacts', () => {
  void test('records and verifies the exact tarball that will be published', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-package-'))
    const tarball = path.join(root, 'velaros-ai-workbench-0.3.0.tgz')
    await writeFile(tarball, 'immutable package bytes')
    const manifest = await createPackageReleaseManifest({
      tarball,
      packageManifest,
      sourceSha,
      releaseTag,
    })

    assert.deepEqual(
      Object.keys(manifest).sort(),
      [
        'fileName',
        'name',
        'releaseTag',
        'schemaVersion',
        'sha256',
        'sizeBytes',
        'sourceSha',
        'version',
      ].sort()
    )
    await validatePackageReleaseManifest({
      tarball,
      manifest,
      packageManifest,
      sourceSha,
      releaseTag,
    })

    await writeFile(tarball, 'mutated package bytes')
    await assert.rejects(
      validatePackageReleaseManifest({
        tarball,
        manifest,
        packageManifest,
        sourceSha,
        releaseTag,
      }),
      /identity conflict/
    )
  })

  void test('npm pack produces exactly one unique tgz', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-pack-'))
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({
        name: '@velaros-ai/release-fixture',
        version: '1.2.3',
        files: ['index.js'],
      })}\n`
    )
    await writeFile(path.join(root, 'index.js'), 'export const ok = true\n')
    const outputDirectory = path.join(root, 'packed')

    const tarball = await packUniqueTarball({
      packageDirectory: root,
      outputDirectory,
    })

    assert.equal(path.basename(tarball), 'velaros-ai-release-fixture-1.2.3.tgz')
    assert.ok((await readFile(tarball)).byteLength > 0)
  })
})
