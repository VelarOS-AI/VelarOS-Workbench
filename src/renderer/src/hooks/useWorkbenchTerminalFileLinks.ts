import { useCallback, useRef } from 'react'

import { useWorkbenchHostRuntime } from '../host'
import { listWorkbenchTerminalLinkCandidates } from '../models/commands/workbenchTerminalFileLinks'

/**
 * 核对过的路径记这么久：鼠标在同一段输出上来回移动时不重复问主进程，文件新建、删掉之后也很快跟上。
 */
const FileCheckTtlMs = 5_000
const MaxCachedFileChecks = 2_000

interface FileCheck {
  checkedAt: number
  isFile: Promise<boolean>
}

/**
 * 终端输出里的路径对应项目里的哪个文件：每个路径按 {@link listWorkbenchTerminalLinkCandidates} 的先后试，
 * 取第一个确实存在的，都不存在给 null。一行里的路径一次问完。
 */
export function useWorkbenchTerminalFileLinks(
  projectRoot: string | undefined
): (paths: readonly string[], cwd: string) => Promise<Array<Nullable<string>>> {
  const hostRuntime = useWorkbenchHostRuntime()
  const checksRef = useRef(new Map<string, FileCheck>())

  return useCallback(
    async (paths, cwd) => {
      if (!projectRoot) return paths.map(() => null)
      const checks = checksRef.current
      const candidatesByPath = paths.map((path) =>
        listWorkbenchTerminalLinkCandidates(projectRoot, cwd, path)
      )
      const candidates = [...new Set(candidatesByPath.flat())]
      const now = Date.now()
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
