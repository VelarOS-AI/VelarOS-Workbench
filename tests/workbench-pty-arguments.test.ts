import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { expect, test } from 'bun:test'

import { loadWorkbenchShellTerminal } from '../src/main/conversation/WorkbenchShellTerminal'
import { buildPtyArguments } from '../src/main/workspace/terminal/PtyArguments'
import { nodePtyFactory } from '../src/main/workspace/terminal/WorkbenchPty'

interface Terminal {
  onData(listener: (text: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
  kill(): void
}
interface Options {
  cwd: string
  env: NodeJS.ProcessEnv
  name: string
  cols: number
  rows: number
  windowsVerbatimArguments?: boolean
}
type Spawn = (file: string, args: string[], options: Options) => Terminal
const options: Options = {
  cwd: process.cwd(),
  env: process.env,
  name: 'xterm-256color',
  cols: 200,
  rows: 24,
}
const require = createRequire(import.meta.url)

function findWindowsExecutable(name: string): string | null {
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  })
  return result.status === 0
    ? (result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? null)
    : null
}

async function output(
  spawn: Spawn,
  file: string,
  args: string[],
  extra: Partial<Options> = {}
): Promise<{ exitCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    let text = ''
    const terminal = spawn(file, args, { ...options, ...extra })
    const timeout = setTimeout(() => {
      terminal.kill()
      reject(new Error('PTY regression timed out'))
    }, 8000)
    terminal.onData((value) => {
      text += value
    })
    terminal.onExit((event) => {
      clearTimeout(timeout)
      resolve({ exitCode: event.exitCode, text })
    })
  })
}

test('PTY arguments preserve POSIX arrays and explicit CMD verbatim commands', () => {
  const args = ['-c', '"C:/Program Files/tool.exe" "中文 文件"']
  expect(buildPtyArguments(args, false, 'linux')).toBe(args)
  expect(buildPtyArguments(args, true, 'darwin')).toBe(args)
  expect(buildPtyArguments(args, true, 'win32')).toBe(args.join(' '))
  expect(buildPtyArguments([''], false, 'win32')).toBe('""')
})

const windowsTest = process.platform === 'win32' ? test : test.skip
windowsTest(
  'real PTY adapters round-trip empty, unicode, spaces, quotes and backslashes',
  async () => {
    const executable = findWindowsExecutable('node')
    expect(executable).not.toBeNull()
    const values = [
      '',
      '中文 路径',
      'a b',
      'a\tb',
      '"both quoted"',
      'a"b',
      'C:\\tail\\',
      'a\\\\"b',
      'a\\"',
    ]
    const script =
      'process.stdout.write("ARGV="+Buffer.from(JSON.stringify(process.argv.slice(1))).toString("base64")+";END")'
    const expected = `ARGV=${Buffer.from(JSON.stringify(values)).toString('base64')};END`
    for (const adapter of adapters()) {
      const result = await output(adapter, executable!, ['-e', script, ...values])
      expect(result.exitCode).toBe(0)
      expect(result.text).toContain(expected)
    }
  },
  30000
)

windowsTest(
  'original quoted Office commands remain one bash argument through pipes and PTYs',
  async () => {
    const bash = findWindowsExecutable('bash')
    if (!bash) return
    const host = process.env.VELAROS_PROCESS_HOST
    const raw = require('@lydell/node-pty') as { spawn: Spawn }
    for (const [app, ext] of [
      ['WINWORD', 'docx'],
      ['POWERPNT', 'pptx'],
    ]) {
      const command = `"C:\\Program Files\\Microsoft Office\\Root\\Office16\\${
        app
      }.EXE" "D:\\VelarOS-Showcase\\2026-10-31\\retake\\desktop-coffee\\便携咖啡机竞品调研与选品决策.${
        ext
      }"`
      // -n 只检查原命令语法，绝不启动 Office。
      const args = ['--noprofile', '--norc', '-n', '-c', command]
      expect(
        spawnSync(bash, args, {
          encoding: 'utf8',
          timeout: 8000,
          windowsHide: true,
        }).status
      ).toBe(0)
      const rawDirect = await output(raw.spawn, bash, args)
      expect([0, 2]).toContain(rawDirect.exitCode)
      for (const adapter of adapters()) expect((await output(adapter, bash, args)).exitCode).toBe(0)
      if (host) {
        const owned = ['--parent-pid', String(process.pid), '--', bash, ...args]
        expect(
          spawnSync(host, owned, {
            encoding: 'utf8',
            timeout: 8000,
            windowsHide: true,
          }).status
        ).toBe(0)
        const rawOwned = await output(raw.spawn, host, owned)
        expect([0, 2]).toContain(rawOwned.exitCode)
        for (const adapter of adapters())
          expect((await output(adapter, host, owned)).exitCode).toBe(0)
      }
    }
  },
  60000
)

windowsTest(
  'explicit CMD verbatim mode still executes an ordinary command',
  async () => {
    const cmd = process.env.ComSpec
    expect(cmd).toBeDefined()
    for (const adapter of adapters()) {
      const result = await output(adapter, cmd!, ['/d', '/s', '/c', '"echo PTY_VERBATIM_OK"'], {
        windowsVerbatimArguments: true,
      })
      expect(result.exitCode).toBe(0)
      expect(result.text).toContain('PTY_VERBATIM_OK')
    }
  },
  30000
)

function adapters(): Spawn[] {
  const factory = loadWorkbenchShellTerminal()
  expect(factory).not.toBeNull()
  return [factory!.spawn, nodePtyFactory.spawn]
}
