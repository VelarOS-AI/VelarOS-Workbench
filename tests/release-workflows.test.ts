import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  assertSingleLocalPlatform,
  resolveLocalReleaseRequest,
} from '../scripts/release/publishUpdateCatalog.mjs'

void describe('release workflows', () => {
  void test('keeps legacy source-repository CI sentinels visibly and fully disabled', async () => {
    const sentinels = new Map([
      ['ci.yml', 'bun run check'],
      [
        'refresh-private-lock-self-hosted.yml',
        'bun scripts/refreshPrivatePackageLock.mjs',
      ],
    ])
    const workflowDirectory = path.resolve('.github/workflows')
    assert.deepEqual(
      (await readdir(workflowDirectory)).sort(),
      [...sentinels.keys()].sort()
    )

    for (const [fileName, localCommand] of sentinels) {
      const workflow = (await readFile(path.join(workflowDirectory, fileName), 'utf8'))
        .replaceAll('\r\n', '\n')
      assert.match(workflow, /^name: "\[DISABLED\] .+"$/mu)
      assert.match(workflow, /^on: \[\]$/mu)
      assert.match(workflow, /permissions: \{\}/u)
      assert.match(workflow, /if: \$\{\{ false \}\}/u)
      assert.match(workflow, /steps:\n {6}- run: exit 1\n$/u)
      assert.ok(workflow.includes(localCommand))
      assert.doesNotMatch(
        workflow,
        /^\s+(?:push|pull_request|schedule|workflow_dispatch):/mu
      )
      assert.doesNotMatch(workflow, /\buses:|secrets\.|vars\./u)
      assert.doesNotMatch(workflow, /\b(?:checkout|build|upload)\b/iu)
      assert.equal(workflow.match(/^ {2}[a-z][a-z0-9-]+:$/gmu)?.length, 1)
    }
  })

  void test('keeps native-platform packaging and finalization in the source repository', async () => {
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
    const require = createRequire(import.meta.url)
    const { load } = require('js-yaml')
    const { resolveFunction } = require('app-builder-lib/out/util/resolve.js')
    const handler = await resolveFunction('module', load(builder).afterPack, 'afterPack', process.cwd())
    assert.equal(typeof handler, 'function')
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
