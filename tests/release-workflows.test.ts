import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, test } from 'bun:test'

void describe('release workflows', () => {
  void test('dispatch modes gate the exact root tag and never clobber release assets', async () => {
    const workflow = (await readFile(
      path.resolve('.github/workflows/release.yml'),
      'utf8'
    )).replaceAll('\r\n', '\n')
    assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:/)
    assert.match(workflow, /tags:\n\s+- 'v\*'/)
    assert.match(workflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}/)
    assert.match(
      workflow,
      /RELEASE_SOURCE_SHA=\$\(git rev-parse HEAD\)/
    )
    assert.doesNotMatch(workflow, /--target "\$GITHUB_SHA"/)
    assert.match(
      workflow,
      /node scripts\/release\/releaseArtifacts\.mjs validate-source/
    )
    assert.match(workflow, /Reuse prior immutable platform checkpoint/)
    assert.match(workflow, /if: steps\.reuse\.outputs\.reuse != 'true'/)
    assert.doesNotMatch(workflow, /--clobber/)

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
