import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  stageReleaseArtifacts,
  validateReleaseTag,
} from '../scripts/release/appReleaseArtifacts.mjs'

void describe('Workbench app release artifacts', () => {
  void test('requires the release tag to equal the app version', async () => {
    await validateReleaseTag(process.cwd(), 'v0.3.0')
    await assert.rejects(
      validateReleaseTag(process.cwd(), 'main'),
      /must equal app version tag v0.3.0/
    )
  })

  void test('stages only platform release files with a unique checksum manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-release-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    await mkdir(path.join(releaseDir, 'mac-arm64'), { recursive: true })
    await Promise.all([
      writeFile(path.join(releaseDir, 'VelarOS-Workbench-0.3.0-mac-arm64.dmg'), 'dmg'),
      writeFile(path.join(releaseDir, 'VelarOS-Workbench-0.3.0-mac-arm64.zip'), 'zip'),
      writeFile(path.join(releaseDir, 'latest-mac.yml'), 'update'),
      writeFile(path.join(releaseDir, 'builder-debug.yml'), 'debug'),
    ])

    const staged = await stageReleaseArtifacts({
      releaseDir,
      stageDir,
      platform: 'macos',
    })

    assert.deepEqual(staged, [
      'VelarOS-Workbench-0.3.0-mac-arm64.dmg',
      'VelarOS-Workbench-0.3.0-mac-arm64.zip',
      'latest-mac.yml',
      'SHA256SUMS-macos.txt',
    ])
    const checksums = await readFile(
      path.join(stageDir, 'SHA256SUMS-macos.txt'),
      'utf8'
    )
    assert.match(checksums, /VelarOS-Workbench-0\.3\.0-mac-arm64\.dmg/)
    assert.doesNotMatch(checksums, /builder-debug/)
  })
})
