import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { readReleaseVersions, validateReleaseSource } from '../scripts/release/releaseIdentity.mjs'

async function createReleaseRepository() {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-source-'))
  await writeFile(path.join(root, 'package.json'), '{"name":"root","version":"0.3.0"}\n')
  await writeFile(
    path.join(root, 'bun.lock'),
    `{
      "workspaces": {
        "": { "name": "root" },
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
  void test('requires exact tag, HEAD, clean tree, and an aligned root lock', async () => {
    const { root, sourceSha } = await createReleaseRepository()
    const identity = await validateReleaseSource({
      repoRoot: root,
      releaseTag: 'v0.3.0',
      sourceSha,
    })
    assert.equal(identity.version, '0.3.0')

    await assert.rejects(
      validateReleaseSource({
        repoRoot: root,
        releaseTag: 'packages-v0.3.0',
        sourceSha,
      }),
      /must equal Workbench version tag v0.3.0/
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

  void test('rejects development links to sibling repositories', async () => {
    const { root, sourceSha } = await createReleaseRepository()
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"root","version":"0.3.0","dependencies":{"@velaros-ai/velaros":"link:@velaros-ai/velaros"}}\n'
    )
    await writeFile(
      path.join(root, 'bun.lock'),
      `{
        "workspaces": {
          "": { "name": "root", "dependencies": { "@velaros-ai/velaros": "link:@velaros-ai/velaros" } },
        },
      }\n`
    )

    await assert.rejects(
      validateReleaseSource({ repoRoot: root, releaseTag: 'v0.3.0', sourceSha }),
      /published dependency versions[\s\S]*dependencies\.@velaros-ai\/velaros link:@velaros-ai\/velaros/
    )
  })

  void test('rejects formal release dependency mappings before source staging', async () => {
    const { root, sourceSha } = await createReleaseRepository()
    try {
      for (const field of ['overrides', 'resolutions']) {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({
          name: 'root', version: '0.3.0', [field]: { react: '19.2.5' },
        }))
        await assert.rejects(
          validateReleaseSource({ repoRoot: root, releaseTag: 'v0.3.0', sourceSha }),
          new RegExp(`published dependency versions[\\s\\S]*${field}\\.react 19\\.2\\.5`, 'u')
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('rejects frozen candidate dependency sources before release staging', async () => {
    const { root, sourceSha } = await createReleaseRepository()
    try {
      const specification = `file:build/runtime-packages/${'a'.repeat(64)}/velaros.tgz`
      const dependencies = { '@velaros-ai/velaros': specification }
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'root', version: '0.3.0', dependencies,
      }))
      await writeFile(path.join(root, 'bun.lock'), JSON.stringify({
        workspaces: { '': { name: 'root', dependencies } },
      }))
      await mkdir(path.join(root, 'resources'))
      await writeFile(path.join(root, 'resources/runtime-snapshot.json'), JSON.stringify({
        schemaVersion: 2,
        sources: {
          platform: {
            kind: 'frozen-local-candidate', repository: 'VelarOS-AI/VelarOS-Platform',
            sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40),
            rawInputFingerprint: 'd'.repeat(64), committedInputFingerprint: 'e'.repeat(64),
            receipt: { path: 'resources/runtime-sources/fixture/candidate.json', sha256: 'f'.repeat(64) },
            commitProof: { path: 'resources/runtime-sources/fixture/proof.json', sha256: '0'.repeat(64) },
          },
        },
        packages: [{
          name: '@velaros-ai/velaros', version: '0.9.1', source: 'platform',
          fileName: 'velaros.tgz', sizeBytes: 1, sha256: 'a'.repeat(64),
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        }],
      }))
      await assert.rejects(
        validateReleaseSource({ repoRoot: root, releaseTag: 'v0.3.0', sourceSha }),
        /require published dependency sources; frozen local candidate/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('rejects a root manifest without the Workbench version', async () => {
    const { root } = await createReleaseRepository()
    await writeFile(path.join(root, 'package.json'), '{"name":"root"}\n')
    await assert.rejects(readReleaseVersions(root), /Workbench version is missing/)
  })

  void test('rejects dependency maps that drift from the immutable lock', async () => {
    const { root } = await createReleaseRepository()
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"root","version":"0.3.0","dependencies":{"@velaros-ai/velaros":"^0.3.0"}}\n'
    )

    await assert.rejects(readReleaseVersions(root), /dependencies must exactly match package\.json/)
  })
})

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
