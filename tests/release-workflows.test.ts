import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'

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
      /node scripts\/release\/releaseArtifacts\.mjs validate-source/
    )
    assert.match(workflow, /Reuse prior immutable platform checkpoint/)
    assert.match(workflow, /if: steps\.reuse\.outputs\.reuse != 'true'/)
    assert.doesNotMatch(workflow, /--clobber/)

    const builder = await readFile(path.resolve('electron-builder.yml'), 'utf8')
    assert.match(builder, /afterPack: \.\/scripts\/release\/verifyPackagedWorkbench\.mjs/u)
  })
})
