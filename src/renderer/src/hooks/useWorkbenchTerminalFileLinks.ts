import { useCallback, useRef } from 'react'

import { useWorkbenchHostRuntime } from '../host/WorkbenchHostProvider'
import { listWorkbenchTerminalLinkCandidates } from '../models/commands/workbenchTerminalFileLinks'

/**
 * 核对过的路径记这么久：鼠标在同一段输出上来回移动时不重复问主进程，文件新建、删掉之后也很快跟上。
 */
const FileCheckTtlMs = 5_000
const MaxCachedFileChecks = 2_000
/** shell 所在的目录隔这么久重新问一次：鼠标划过一段输出时只问一回，`cd` 之后也很快跟上。 */
const CwdTtlMs = 2_000
const MaxCachedCwds = 64

interface FileCheck {
  checkedAt: number
  isFile: Promise<boolean>
}

interface CwdRead {
  readAt: number
  cwd: Promise<Nullable<string>>
}

/**
 * 终端输出里的路径对应项目里的哪个文件：每个路径按 {@link listWorkbenchTerminalLinkCandidates} 的先后试，
 * 取第一个确实存在的，都不存在给 null。一行里的路径一次问完。
 *
 * 相对路径按 shell 此刻所在的目录解析：先问主进程（它问操作系统，不靠 shell 报），问不到（Windows、会话已
 * 结束）就用终端自己知道的 `cwd`（shell 用 OSC 7 报的，或者起始目录）。
 */
export function useWorkbenchTerminalFileLinks(
  projectRoot: string | undefined
): (
  paths: readonly string[],
  cwd: string,
  sessionId: string
) => Promise<Array<Nullable<string>>> {
  const hostRuntime = useWorkbenchHostRuntime()
  const checksRef = useRef(new Map<string, FileCheck>())
  const cwdReadsRef = useRef(new Map<string, CwdRead>())

  return useCallback(
    async (paths, knownCwd, sessionId) => {
      if (!projectRoot) return paths.map(() => null)
      const checks = checksRef.current
      const cwdReads = cwdReadsRef.current
      const now = Date.now()
      let cwdRead = cwdReads.get(sessionId)
      if (!cwdRead || now - cwdRead.readAt > CwdTtlMs) {
        if (cwdReads.size > MaxCachedCwds) cwdReads.clear()
        cwdRead = {
          readAt: now,
          cwd: hostRuntime.kernel.project.readWorkbenchTerminalCwd({ sessionId }).then(
            (result) => (result.ok ? result.data.cwd : null),
            () => null
          ),
        }
        cwdReads.set(sessionId, cwdRead)
      }
      const cwd = (await cwdRead.cwd) ?? knownCwd
      const candidatesByPath = paths.map((path) =>
        listWorkbenchTerminalLinkCandidates(projectRoot, cwd, path)
      )
      const candidates = [...new Set(candidatesByPath.flat())]
      const keyOf = (path: string): string => `${projectRoot}\0${path}`
      const unchecked = candidates.filter((path) => {
        const check = checks.get(keyOf(path))
        return !check || now - check.checkedAt > FileCheckTtlMs
      })
      if (unchecked.length > 0) {
        if (checks.size > MaxCachedFileChecks) checks.clear()
        const found = hostRuntime.kernel.project
          .findExistingWorkbenchFiles({ projectRoot, paths: unchecked })
          .then(
            (result) => new Set(result.ok ? result.data.paths : []),
            () => new Set<string>()
          )
        for (const path of unchecked)
          checks.set(keyOf(path), { checkedAt: now, isFile: found.then((files) => files.has(path)) })
      }

      const isFile = new Map(
        await Promise.all(
          candidates.map(async (path) => [path, await checks.get(keyOf(path))!.isFile] as const)
        )
      )
      return candidatesByPath.map((list) => list.find((path) => isFile.get(path)) ?? null)
    },
    [hostRuntime, projectRoot]
  )
}
