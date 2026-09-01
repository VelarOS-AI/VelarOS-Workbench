import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'
import ts from 'typescript'

import {
  findPackagedWorkbenchAppOutDir,
  resolvePackagedWorkbenchPaths,
} from '../scripts/release/verifyPackagedWorkbench.mjs'
import {
  buildExternalLspProcessTreeTerminationPlan,
  shouldDetachExternalLspProcess,
} from '../src/main/workspace/language/ExternalLspProcessLifecycle'
import { resolveTypeScriptDefaultLibFilePath } from '../src/main/workspace/language/TypeScriptProjectHost'

void describe('Workbench cross-platform lifecycle', () => {
  void test('terminates external language servers as complete process trees', () => {
    assert.equal(shouldDetachExternalLspProcess('win32'), false)
    assert.equal(shouldDetachExternalLspProcess('linux'), true)
    assert.deepEqual(buildExternalLspProcessTreeTerminationPlan(42, 'SIGKILL', 'win32'), {
      kind: 'command',
      file: 'taskkill',
      args: ['/PID', '42', '/T', '/F'],
    })
    assert.deepEqual(buildExternalLspProcessTreeTerminationPlan(42, 'SIGTERM', 'darwin'), {
      kind: 'signal',
      pid: -42,
      fallbackPid: 42,
      signal: 'SIGTERM',
    })
  })

  void test('verifies the native resource layout for every packaged platform', () => {
    assert.equal(
      resolvePackagedWorkbenchPaths('/tmp/mac-arm64', 'darwin').appArchive,
      join(
        '/tmp/mac-arm64',
        'VelarOS Workbench.app',
        'Contents',
        'Resources',
        'app.asar'
      )
    )
    assert.equal(
      resolvePackagedWorkbenchPaths('C:\\release\\win-unpacked', 'win32').appArchive,
      join('C:\\release\\win-unpacked', 'resources', 'app.asar')
    )
    assert.equal(
      resolvePackagedWorkbenchPaths('/tmp/linux-unpacked', 'linux').typeScriptLibRoot,
      join('/tmp/linux-unpacked', 'resources', 'typescript', 'lib')
    )
  })

  void test('loads TypeScript standard libraries from packaged resources', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'workbench-typescript-libs-'))
    const bundledLibDirectory = join(resourcesPath, 'typescript', 'lib')
    await mkdir(bundledLibDirectory, { recursive: true })
    await writeFile(join(bundledLibDirectory, 'lib.esnext.full.d.ts'), '', 'utf8')

    try {
      assert.equal(
        resolveTypeScriptDefaultLibFilePath({ target: ts.ScriptTarget.ESNext }, resourcesPath),
        join(bundledLibDirectory, 'lib.esnext.full.d.ts')
      )
    } finally {
      await rm(resourcesPath, { recursive: true, force: true })
    }
  })

  void test('keeps Linux and Windows unpacked directories distinguishable', async () => {
    const releaseDirectory = await mkdtemp(join(tmpdir(), 'workbench-packaged-layout-'))
    const appOutDir = join(releaseDirectory, 'linux-unpacked')
    await mkdir(join(appOutDir, 'resources'), { recursive: true })
    await writeFile(join(appOutDir, 'resources', 'app.asar'), '', 'utf8')

    try {
      assert.deepEqual(await findPackagedWorkbenchAppOutDir(releaseDirectory), {
        appOutDir,
        platformName: 'linux',
      })
    } finally {
      await rm(releaseDirectory, { recursive: true, force: true })
    }
  })
})
