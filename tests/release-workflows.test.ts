import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'

void describe('release workflows', () => {
  void test('app dispatch modes gate the exact root tag and never clobber release assets', async () => {
    const appWorkflow = (await readFile(
      path.resolve('.github/workflows/release-app.yml'),
      'utf8'
    )).replaceAll('\r\n', '\n')
    assert.match(appWorkflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:/)
    assert.match(appWorkflow, /tags:\n\s+- 'v\*'/)
    assert.match(appWorkflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}/)
    assert.match(
      appWorkflow,
      /node scripts\/release\/appReleaseArtifacts\.mjs validate-source/
    )
    assert.match(appWorkflow, /Reuse prior immutable platform checkpoint/)
    assert.match(appWorkflow, /if: steps\.reuse\.outputs\.reuse != 'true'/)
    assert.doesNotMatch(appWorkflow, /--clobber/)
  })
})
