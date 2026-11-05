/**
 * 终端会话的进程树：伪终端上的 shell 只是根，它起的前台任务、放到后台的任务（`&`、`nohup`）、任务自己再派生的
 * 进程都挂在它下面。停止会话时整棵树一起结束，不留下还占着端口、还在写文件的进程。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** 进程表的输出上限：几千个进程的 `pid ppid` 也不到 1 MB。 */
const ProcessListMaxBytes = 8 * 1024 * 1024

/** 从 `ps -A -o pid=,ppid=` 的输出里找出 `rootPid` 和它所有的子孙（根在前，按层次）。 */
export function collectWorkbenchProcessTree(processList: string, rootPid: number): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const children = new Map<number, number[]>()
  for (const line of processList.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number)
    if (!pid || ppid === undefined || !Number.isFinite(ppid)) continue
    const siblings = children.get(ppid)
    if (siblings) siblings.push(pid)
    else children.set(ppid, [pid])
  }

  const tree: number[] = []
  const seen = new Set<number>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return tree
}

/**
 * 列出 `rootPid` 这棵进程树。要在根退出之前列：根一退，子孙会被 init 收养，就顺不到它们了。
 * Windows 用 CIM 保留真实子进程号，避免 taskkill /T 遗漏刚启动的进程；列不出来时退回根进程。
 */
export async function listWorkbenchProcessTree(rootPid: number): Promise<number[]> {
  // Windows ConPTY 在部分 Electron 运行时不公开 shell PID（node-pty 返回 0）。
  // 绝不能把 0 当作进程树根，否则会沿系统空闲进程枚举到 PID 4 等系统进程。
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await execFileAsync(
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
            ],
            { maxBuffer: ProcessListMaxBytes, timeout: 10_000, windowsHide: true }
          )
        : await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
            maxBuffer: ProcessListMaxBytes,
          })
    return collectWorkbenchProcessTree(stdout, rootPid)
  } catch {
    // arch-guard:silent-catch-ok 列不出进程表（沙箱、没有 ps）时退回只结束根进程，关伪终端时前台进程组还会收到 SIGHUP。
    return [rootPid]
  }
}

/**
 * 给一组进程发信号；已经退出的跳过。子孙先于根收到，根（shell）不会在子孙之前退出、把它们交给 init。
 * Windows 上用 `taskkill /T /F` 结束根下的整棵树（不加 /F 时控制台程序常常结束不了）。
 */
export async function signalWorkbenchProcesses(
  pids: readonly number[],
  signal: NodeJS.Signals
): Promise<void> {
  const errors: unknown[] = []
  const validPids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  for (const pid of validPids.reverse()) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 10_000,
        })
      } else {
        process.kill(pid, signal)
      }
    } catch (error) {
      // 不依赖本地化的 taskkill stderr 或模糊退出码；只有 ESRCH 能确认目标已不存在。
      // 启动失败、权限不足、超时等仍保留原始错误，并继续清理树上其他 PID。
      if (process.platform === 'win32') {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (
          typeof failure.code === 'number' &&
          !failure.killed &&
          !failure.signal &&
          isProcessGone(pid)
        )
          continue
      } else if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        continue
      }
      errors.push(new Error(`Failed to send ${signal} to PID ${pid}`, { cause: error }))
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'Failed to terminate terminal process tree')
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
