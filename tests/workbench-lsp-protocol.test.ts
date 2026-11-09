import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, test } from 'bun:test'

import { optionalWhen } from '@velaros-ai/velaros/core'

import { ExternalLspClient } from '../src/main/workspace/language/ExternalLspClient'
import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import {
  shouldDetachExternalLspProcess,
  terminateExternalLspProcessTree,
} from '../src/main/workspace/language/ExternalLspProcessLifecycle'

const fixture = fileURLToPath(new URL('./fixtures/protocol-lsp.cjs', import.meta.url))

function protocolClient(
  lspProcesses: ExternalLspProcessHost,
  projectRoot: string,
  mode: string
): ExternalLspClient {
  return new ExternalLspClient(lspProcesses, projectRoot, {
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

function extensionClient(
  lspProcesses: ExternalLspProcessHost,
  projectRoot: string,
  declared = true
): ExternalLspClient {
  return new ExternalLspClient(lspProcesses, projectRoot, {
    id: 'protocol-fixture-extension',
    label: 'Protocol Fixture Language',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['protocol'],
    languages: ['protocol-fixture'],
    command: process.execPath,
    args: [fixture, 'extension'],
    documentLanguageId: 'protocol-fixture',
    extensionRequests: optionalWhen(declared, [
      {
        id: 'ownership-graph',
        method: 'velar/ownershipGraph',
        capabilityPath: ['experimental', 'velar', 'ownershipGraph'],
      },
    ]),
  })
}

void describe('external LSP protocol boundaries', () => {
  void test('answers server-initiated requests instead of treating them as responses', async () => {
    const lspProcesses = new ExternalLspProcessHost()
    try {
      const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-protocol-'))
      const client = protocolClient(lspProcesses, projectRoot, 'server-request')
      try {
        const { items: completions } = await client.completion(
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
        const disposal = client.dispose()
        assert.equal(client.dispose(), disposal)
        await disposal
        await rm(projectRoot, { recursive: true, force: true })
      }
    } finally {
      await lspProcesses.close()
    }
  })

  void test('reassembles a large response split across chunk and header boundaries', async () => {
    const lspProcesses = new ExternalLspProcessHost()
    try {
      const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-chunked-'))
      const client = protocolClient(lspProcesses, projectRoot, 'chunked')
      try {
        const { items: completions } = await client.completion(
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
    } finally {
      await lspProcesses.close()
    }
  })

  void test('transports only declared, capability-gated extension requests', async () => {
    const lspProcesses = new ExternalLspProcessHost()
    try {
      const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-extension-'))
      const client = extensionClient(lspProcesses, projectRoot)
      try {
        const path = join(projectRoot, 'main.protocol')
        const first = (await client.requestExtension(path, 'first', 'ownership-graph', {
          maximumNodes: 120,
          textDocument: { uri: 'file:///spoofed' },
          version: 999,
        })) as {
          params: { maximumNodes: number; textDocument: { uri: string }; version: number }
        }
        assert.equal(first.params.maximumNodes, 120)
        assert.equal(first.params.textDocument.uri.startsWith('file://'), true)
        assert.equal(first.params.textDocument.uri.includes('spoofed'), false)
        assert.equal(first.params.version, 1)

        const changedPath = join(projectRoot, 'changed.protocol')
        await client.filesChanged([changedPath])
        const second = (await client.requestExtension(path, 'second', 'ownership-graph')) as {
          params: { version: number }
          fileChanges: Array<{ uri: string; type: number }>
        }
        assert.equal(second.params.version, 2)
        assert.equal(second.fileChanges.length, 1)
        assert.equal(second.fileChanges[0]?.uri.includes('changed.protocol'), true)
        assert.equal(second.fileChanges[0]?.type, 2)

        const preserved = (await client.requestExtension(
          path,
          'stale disk content',
          'ownership-graph',
          {},
          true
        )) as { params: { version: number } }
        assert.equal(preserved.params.version, 2)
      } finally {
        await client.dispose()
        await rm(projectRoot, { recursive: true, force: true })
      }
    } finally {
      await lspProcesses.close()
    }
  })

  void test('rejects an undeclared extension request before starting the language server', async () => {
    const lspProcesses = new ExternalLspProcessHost()
    try {
      const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-lsp-extension-deny-'))
      const client = extensionClient(lspProcesses, projectRoot, false)
      try {
        await assert.rejects(
          client.requestExtension(join(projectRoot, 'main.protocol'), '', 'ownership-graph'),
          /没有声明语言扩展请求/u
        )
      } finally {
        await client.dispose()
        await rm(projectRoot, { recursive: true, force: true })
      }
    } finally {
      await lspProcesses.close()
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
    const exit = once(child, 'exit')
    const close = once(child, 'close')
    try {
      // 等到 SIGTERM 处理器真的装上，否则终止信号可能落在 Bun 启动期间。
      await waitForOutput(child.stdout)
      assert.equal(await terminateExternalLspProcessTree(child.pid), true)
      const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null]
      if (process.platform === 'win32') {
        assert.equal(signal, null)
        assert.notEqual(code, null)
      } else {
        assert.equal(signal, 'SIGKILL')
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        } else {
          child.kill('SIGKILL')
        }
      }
      await close
    }
  })
})

async function waitForOutput(stream: NodeJS.ReadableStream): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      once(stream, 'data').then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for the fixture process.')),
          1_000
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
