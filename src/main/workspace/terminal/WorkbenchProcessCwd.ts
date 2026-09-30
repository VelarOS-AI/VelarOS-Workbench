/**
 * 一个进程此刻所在的目录，问操作系统：shell 里 `cd` 到哪儿了，终端自己并不知道（不是每个 shell 都用 OSC 7 报）。
 * Linux 读 `/proc/<pid>/cwd`，macOS 用系统自带的 `lsof`；Windows 没有现成的办法，给 null。
 */
import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const LsofPath = '/usr/sbin/lsof'
const LsofTimeoutMs = 2_000
const LsofEscapes: Readonly<Record<string, number>> = { b: 8, t: 9, n: 10, f: 12, r: 13, '\\': 92 }

/**
 * 从 `lsof -Fn` 的输出里取出路径：每行一个字段，`n` 打头的是名字。lsof 在认不出的字符集下把非 ASCII 字节写成
 * `\xNN`、反斜杠写成 `\\`，这里还原成原来的路径。
 */
export function parseLsofCwd(output: string): Nullable<string> {
  const field = output.split('\n').find((line) => line.startsWith('n') && line.length > 1)
  if (!field) return null

  const bytes: number[] = []
  const name = Buffer.from(field.slice(1), 'utf8')
  for (let index = 0; index < name.length; index += 1) {
    const byte = name[index]!
    if (byte !== 92 || index + 1 >= name.length) {
      bytes.push(byte)
      continue
    }
    const next = String.fromCharCode(name[index + 1]!)
    const hex = name.subarray(index + 2, index + 4).toString('latin1')
    if (next === 'x' && /^[0-9a-f]{2}$/iu.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      index += 3
    } else if (LsofEscapes[next] !== undefined) {
      bytes.push(LsofEscapes[next])
      index += 1
    } else {
      bytes.push(byte)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 进程已经退出、没有 lsof、没权限看，都当作问不到。 */
export async function readWorkbenchProcessCwd(pid: number): Promise<Nullable<string>> {
  try {
    if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`)
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        LsofPath,
        ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'],
        { timeout: LsofTimeoutMs, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }
      )
      return parseLsofCwd(stdout)
    }
  } catch {
    // arch-guard:silent-catch-ok 进程已退出、系统上没有 lsof、没权限看别的进程：问不到就按不知道处理。
  }
  return null
}
