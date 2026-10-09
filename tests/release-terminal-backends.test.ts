import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'bun:test'

import { verifyPackagedTerminalBackend } from '../scripts/release/verifyPackagedWorkbench.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(platform: string, files: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-release-terminal-'))
  roots.push(root)
  const prefix = join(root, 'app.asar.unpacked/node_modules/@lydell', `node-pty-${platform}-x64/prebuilds/${platform}-x64`)
  for (const name of files) {
    const file = join(prefix, name)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'native')
  }
  return { root, prefix }
}

for (const platform of ['linux', 'win32']) {
  void test(`${platform} verifies its own terminal files without requiring a macOS helper`, async () => {
    const files = platform === 'win32'
      ? ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
      : ['pty.node']
    const { root, prefix } = await fixture(platform, files)
    await verifyPackagedTerminalBackend(root, platform)
    for (const name of files) {
      await rm(join(prefix, name))
      await assert.rejects(verifyPackagedTerminalBackend(root, platform), /missing/u)
      await writeFile(join(prefix, name), 'native')
    }
  })
}

void test.skipIf(process.platform === 'win32')('macOS requires an executable spawn helper', async () => {
  const { root, prefix } = await fixture('darwin', ['pty.node'])
  await assert.rejects(verifyPackagedTerminalBackend(root, 'darwin'), /missing spawn-helper/u)
  const helper = join(prefix, 'spawn-helper')
  await writeFile(helper, 'native')
  await chmod(helper, 0o644)
  await assert.rejects(verifyPackagedTerminalBackend(root, 'darwin'), /not executable/u)
  await chmod(helper, 0o755)
  await verifyPackagedTerminalBackend(root, 'darwin')
})
