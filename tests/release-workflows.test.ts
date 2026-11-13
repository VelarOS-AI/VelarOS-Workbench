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
      ['refresh-private-lock-self-hosted.yml', 'bun scripts/refreshPrivatePackageLock.mjs'],
    ])
    const workflowDirectory = path.resolve('.github/workflows')
    assert.deepEqual(
      (await readdir(workflowDirectory)).sort(),
      [...sentinels.keys(), 'release-workbench.yml'].sort()
    )

    for (const [fileName, localCommand] of sentinels) {
      const workflow = (await readFile(path.join(workflowDirectory, fileName), 'utf8')).replaceAll(
        '\r\n',
        '\n'
      )
      assert.match(workflow, /^name: "\[DISABLED\] .+"$/mu)
      assert.match(workflow, /^on: \[\]$/mu)
      assert.match(workflow, /permissions: \{\}/u)
      assert.match(workflow, /if: \$\{\{ false \}\}/u)
      assert.match(workflow, /steps:\n {6}- run: exit 1\n$/u)
      assert.ok(workflow.includes(localCommand))
      assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule|workflow_dispatch):/mu)
      assert.doesNotMatch(workflow, /\buses:|secrets\.|vars\./u)
      assert.doesNotMatch(workflow, /\b(?:checkout|build|upload)\b/iu)
      assert.equal(workflow.match(/^ {2}[a-z][a-z0-9-]+:$/gmu)?.length, 1)
    }
  })

  void test('gates the public release entry on manual immutable source and native checks', async () => {
    const workflow = await readFile(path.resolve('.github/workflows/release-workbench.yml'), 'utf8')
    const require = createRequire(import.meta.url)
    const { load } = require('js-yaml')
    const parsed = load(workflow) as {
      on: Record<string, { inputs: Record<string, { required?: boolean }> }>
      permissions: Record<string, string>
      concurrency: { group: string; 'cancel-in-progress': boolean }
      jobs: Record<
        string,
        {
          if?: string
          environment?: string
          strategy?: { matrix: { include: Array<{ platform_key: string }> } }
        }
      >
    }
    assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch'])
    assert.equal(parsed.on.workflow_dispatch.inputs.source_commit.required, true)
    assert.deepEqual(parsed.permissions, { contents: 'read', actions: 'read' })
    assert.equal(parsed.concurrency.group, 'workbench-all-platforms-release')
    assert.equal(parsed.concurrency['cancel-in-progress'], false)
    assert.equal(parsed.jobs.source.if, "github.ref == 'refs/heads/main'")
    assert.equal(parsed.jobs.native.environment, 'release-candidates')
    assert.deepEqual(
      parsed.jobs.native.strategy?.matrix.include.map((entry) => entry.platform_key).sort(),
      ['darwin-arm64', 'linux-x64', 'win32-x64']
    )
    assert.ok(workflow.includes("git('cat-file', '-t', tag) !== 'tag'"))
    assert.ok(workflow.includes('bun run check'))
    assert.ok(workflow.includes('bun run release:local:verify'))
    assert.ok(workflow.includes('assertCatalogMatchesCompletion'))
    assert.doesNotMatch(workflow, /secrets\.ONCE_BUILD_TOKEN|VelarOS-AI\/VelarOS-Desktop/u)
  })

  void test('keeps native-platform packaging and finalization in the source repository', async () => {
    await assert.rejects(readFile(path.resolve('.github/workflows/release.yml'), 'utf8'), /ENOENT/u)

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

    assert.deepEqual(resolveLocalReleaseRequest(['macos', 'artifacts/stage'], 'darwin'), {
      releasePlatform: 'macos',
      releaseDirectory: 'artifacts/stage',
    })
    assert.deepEqual(resolveLocalReleaseRequest(['--', 'windows', 'artifacts/stage'], 'win32'), {
      releasePlatform: 'windows',
      releaseDirectory: 'artifacts/stage',
    })
    assert.throws(
      () => resolveLocalReleaseRequest(['windows', 'artifacts/stage'], 'darwin'),
      /current host publishes macos only/u
    )
    assert.throws(
      () => assertSingleLocalPlatform(['macos', 'windows'], 'macos'),
      /exactly one macos stage receipt/u
    )
    assert.doesNotThrow(() => assertSingleLocalPlatform(['macos'], 'macos'))

    const builder = (await readFile(path.resolve('electron-builder.yml'), 'utf8')).replaceAll(
      '\r\n',
      '\n'
    )
    const require = createRequire(import.meta.url)
    const { load } = require('js-yaml')
    const { resolveFunction } = require('app-builder-lib/out/util/resolve.js')
    const handler = await resolveFunction(
      'module',
      load(builder).afterPack,
      'afterPack',
      process.cwd()
    )
    assert.equal(typeof handler, 'function')
  })

  void test('keeps Linux package maintainer metadata complete', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      author?: { name?: string; email?: string }
      desktopName?: string
    }
    const builder = (await readFile(path.resolve('electron-builder.yml'), 'utf8')).replaceAll(
      '\r\n',
      '\n'
    )

    assert.equal(manifest.author?.name, 'VelarOS')
    assert.match(manifest.author?.email ?? '', /^[^@\s]+@[^@\s]+\.[^@\s]+$/u)
    assert.equal(manifest.desktopName, 'velaros-workbench.desktop')
    assert.match(builder, /linux:\n(?:.*\n)*?\s+syncDesktopName: true/u)
  })
})
