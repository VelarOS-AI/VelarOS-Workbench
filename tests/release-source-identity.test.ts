import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  readReleaseVersions,
  validateReleaseSource,
} from '../scripts/release/releaseIdentity.mjs'

async function createReleaseRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-source-'))
  await mkdir(path.join(root, 'apps/workbench'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"root","version":"0.3.0"}\n'
  )
  await writeFile(
    path.join(root, 'apps/workbench/package.json'),
    '{"name":"app","version":"0.3.0"}\n'
  )
  await writeFile(
    path.join(root, 'bun.lock'),
    `{
      "workspaces": {
        "apps/workbench": { "version": "0.3.0" },
      },
    }\n`
  )
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'release@example.com'])
  git(root, ['config', 'user.name', 'Release Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'release source'])
  git(root, ['tag', 'v0.3.0'])
  return { root, sourceSha: git(root, ['rev-parse', 'HEAD']) }
}

void describe('release source identity', () => {
  void test('requires exact tag, HEAD, clean tree, and aligned manifest/lock versions', async () => {
    const { root, sourceSha } = await createReleaseRepository()
    const identity = await validateReleaseSource({
      repoRoot: root,
      releaseTag: 'v0.3.0',
      sourceSha,
    })
    assert.equal(identity.appVersion, '0.3.0')

    await assert.rejects(
      validateReleaseSource({
        repoRoot: root,
        releaseTag: 'packages-v0.3.0',
        sourceSha,
      }),
      /must equal root version tag v0.3.0/
    )
    await assert.rejects(
      validateReleaseSource({
        repoRoot: root,
        releaseTag: 'v0.3.0',
        sourceSha: '0'.repeat(40),
      }),
      /must equal source SHA/
    )
    await writeFile(path.join(root, 'dirty.txt'), 'dirty')
    await assert.rejects(
      validateReleaseSource({
        repoRoot: root,
        releaseTag: 'v0.3.0',
        sourceSha,
      }),
      /must be clean/
    )
  })

  void test('rejects app versions that drift from root', async () => {
    const { root } = await createReleaseRepository()
    await writeFile(
      path.join(root, 'apps/workbench/package.json'),
      '{"name":"app","version":"0.2.0"}\n'
    )
    await assert.rejects(
      readReleaseVersions(root),
      /app version 0.2.0 must equal root version 0.3.0/
    )
  })

  void test('rejects dependency maps that drift from the immutable lock', async () => {
    const { root } = await createReleaseRepository()
    await writeFile(
      path.join(root, 'apps/workbench/package.json'),
      '{"name":"app","version":"0.3.0","dependencies":{"@velaros-ai/core":"^0.3.0"}}\n'
    )

    await assert.rejects(
      readReleaseVersions(root),
      /dependencies must exactly match package\.json/
    )
  })
})

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
