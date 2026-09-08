import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  assertSingleLocalPlatform,
  resolveLocalReleaseRequest,
} from '../scripts/release/publishUpdateCatalog.mjs'

void describe('release workflows', () => {
  void test('uses local native-platform release commands without an Actions release workflow', async () => {
    await assert.rejects(
      readFile(path.resolve('.github/workflows/release.yml'), 'utf8'),
      /ENOENT/u
    )

    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    assert.equal(
      manifest.scripts?.['release:local:stage'],
      'node scripts/release/releaseArtifacts.mjs stage'
    )
    assert.equal(
      manifest.scripts?.['release:local:verify'],
      'node scripts/release/releaseArtifacts.mjs verify'
    )
    assert.equal(
      manifest.scripts?.['release:local:finalize'],
      'node scripts/release/publishUpdateCatalog.mjs'
    )
    assert.match(manifest.scripts?.['package:win'] ?? '', /--publish never/u)
    assert.match(manifest.scripts?.['package:linux'] ?? '', /--publish never/u)

    assert.deepEqual(
      resolveLocalReleaseRequest(['macos', 'artifacts/stage'], 'darwin'),
      { releasePlatform: 'macos', releaseDirectory: 'artifacts/stage' }
    )
    assert.deepEqual(
      resolveLocalReleaseRequest(['--', 'windows', 'artifacts/stage'], 'win32'),
      { releasePlatform: 'windows', releaseDirectory: 'artifacts/stage' }
    )
    assert.throws(
      () => resolveLocalReleaseRequest(['windows', 'artifacts/stage'], 'darwin'),
      /current host publishes macos only/u
    )
    assert.throws(
      () => assertSingleLocalPlatform(['macos', 'windows'], 'macos'),
      /exactly one macos stage receipt/u
    )
    assert.doesNotThrow(() => assertSingleLocalPlatform(['macos'], 'macos'))

    const builder = (await readFile(path.resolve('electron-builder.yml'), 'utf8'))
      .replaceAll('\r\n', '\n')
    assert.match(builder, /afterPack: \.\/scripts\/release\/verifyPackagedWorkbench\.mjs/u)
  })

  void test('keeps Linux package maintainer metadata complete', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      author?: { name?: string; email?: string }
      desktopName?: string
    }
    const builder = (await readFile(path.resolve('electron-builder.yml'), 'utf8'))
      .replaceAll('\r\n', '\n')

    assert.equal(manifest.author?.name, 'VelarOS')
    assert.match(manifest.author?.email ?? '', /^[^@\s]+@[^@\s]+\.[^@\s]+$/u)
    assert.equal(manifest.desktopName, 'velaros-workbench.desktop')
    assert.match(builder, /linux:\n(?:.*\n)*?\s+syncDesktopName: true/u)
  })
})
