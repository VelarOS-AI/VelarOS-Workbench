import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'

void describe('release workflows', () => {
  void test('both dispatch modes gate the exact root tag and never clobber release assets', async () => {
    const appWorkflow = await readFile(
      path.resolve('.github/workflows/release-app.yml'),
      'utf8'
    )
    const packageWorkflow = await readFile(
      path.resolve('.github/workflows/release-packages.yml'),
      'utf8'
    )

    for (const workflow of [appWorkflow, packageWorkflow]) {
      assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+release_tag:/)
      assert.match(workflow, /tags:\n\s+- 'v\*'/)
      assert.match(workflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}/)
      assert.match(
        workflow,
        /node scripts\/release\/appReleaseArtifacts\.mjs validate-source/
      )
    }
    assert.match(appWorkflow, /Reuse prior immutable platform checkpoint/)
    assert.match(appWorkflow, /if: steps\.reuse\.outputs\.reuse != 'true'/)
    assert.doesNotMatch(appWorkflow, /--clobber/)
    assert.match(
      packageWorkflow,
      /Pack, record, and publish the same immutable tarball/
    )
  })
})
