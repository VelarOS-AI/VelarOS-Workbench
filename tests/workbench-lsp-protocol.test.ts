import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExternalLspClient } from '../src/main/workspace/language/ExternalLspClient'
import {
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
} from '../src/main/workspace/language/ExternalLspProcessLifecycle'

const fixture = fileURLToPath(new URL('./fixtures/protocol-lsp.cjs', import.meta.url))

function protocolClient(projectRoot: string, mode: string): ExternalLspClient {
  return new ExternalLspClient(projectRoot, {
    id: `protocol-fixture-${mode}`,
    label: 'Protocol Fixture Language',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['protocol'],
    languages: ['protocol-fixture'],
    command: process.execPath,
    args: [fixture, mode],
    documentLanguageId: 'protocol-fixture',
  })
}

void describe('external LSP protocol boundaries', () => {
  void test('answers server-initiated requests instead of treating them as responses', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-protocol-'))
    const client = protocolClient(projectRoot, 'server-request')
    try {
      const completions = await client.completion(
        join(projectRoot, 'probe.protocol'),
        'comp',
        { line: 0, character: 4 }
      )
      const observed = JSON.parse(completions[0]?.label ?? '{}') as Record<string, string>

      // initialize 的返回值没有被同 id 的服务端请求顶掉——否则 capabilities 为空，补全直接消失。
      assert.equal(completions.length, 1)
      // 服务端请求都拿到了回复，没有一条被静默丢弃。
      assert.equal(observed['registerCapability'], 'null')
      assert.equal(observed['unknownMethod'], 'error:-32601')
      assert.equal(observed['configuration'], '[null,null]')
      const folders = JSON.parse(observed['workspaceFolders'] ?? 'null') as Array<{ uri: string }>
      assert.equal(folders.length, 1)
      assert.equal(folders[0]?.uri.startsWith('file://'), true)
    } finally {
      await client.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('reassembles a large response split across chunk and header boundaries', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-chunked-'))
    const client = protocolClient(projectRoot, 'chunked')
    try {
      const completions = await client.completion(
        join(projectRoot, 'probe.protocol'),
        'comp',
        { line: 0, character: 4 }
      )
      const label = completions[0]?.label ?? ''

      assert.equal(label.length, 512 * 1024)
      assert.equal(label.startsWith('组件组件'), true)
      assert.equal(label.endsWith('组件组件'), true)
      assert.equal(label.replaceAll('组件', ''), '')
    } finally {
      await client.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

void describe('external LSP process termination', () => {
  void test('reports a missing process instead of signalling a recycled pid', async () => {
    assert.equal(await terminateExternalLspProcessTree(undefined), false)

    const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(finished, 'exit')
    assert.equal(await terminateExternalLspProcessTree(finished.pid), false)
  })

  void test('escalates to SIGKILL when the process tree ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready")',
      ],
      { detached: shouldDetachExternalLspProcess(), stdio: ['ignore', 'pipe', 'ignore'] }
    )
    // 等到 SIGTERM 处理器真的装上，否则终止信号可能落在 Node 启动期间。
    await once(child.stdout, 'data')
    const exit = once(child, 'exit')
    try {
      assert.equal(await terminateExternalLspProcessTree(child.pid), true)
      const [, signal] = await exit as [number | null, NodeJS.Signals | null]
      assert.equal(signal, 'SIGKILL')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})
