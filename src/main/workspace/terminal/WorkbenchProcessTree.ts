/**
 * 终端会话的进程树：伪终端上的 shell 只是根，它起的前台任务、放到后台的任务（`&`、`nohup`）、任务自己再派生的
 * 进程都挂在它下面。停止会话时整棵树一起结束，不留下还占着端口、还在写文件的进程。
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** 进程表的输出上限：几千个进程的 `pid ppid` 也不到 1 MB。 */
const ProcessListMaxBytes = 8 * 1024 * 1024

/** 从 `ps -A -o pid=,ppid=` 的输出里找出 `rootPid` 和它所有的子孙（根在前，按层次）。 */
export function collectWorkbenchProcessTree(processList: string, rootPid: number): number[] {
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
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ], { maxBuffer: ProcessListMaxBytes, timeout: 10_000, windowsHide: true })
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
export function signalWorkbenchProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    for (const pid of [...pids].reverse()) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        // arch-guard:silent-catch-ok 进程树已经不在了（taskkill 找不到进程）。
      }
    }
    return
  }
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal)
    } catch {
      // arch-guard:silent-catch-ok 进程已经退出（ESRCH），正是想要的结果。
    }
  }
}
