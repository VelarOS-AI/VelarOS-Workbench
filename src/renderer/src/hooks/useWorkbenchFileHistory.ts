import { useCallback, useEffect, useRef, useState } from 'react'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { AppLocale } from '@shared/contracts'

import { useWorkbenchHostRuntime,type WorkbenchHostRuntime } from '../host'
import { formatWorkbenchGitCommitDate } from '../models/git/changesPanel.model'

export type WorkbenchFileHistoryMode = 'local' | 'git'

const GIT_HISTORY_COMMIT_LIMIT = 60

export interface WorkbenchFileHistoryRecord {
  id: string
  /** 主标题：本地=快照时间，git=提交主题。 */
  title: string
  /** 次要信息：git 作者。 */
  subtitle?: LooseOptional<string>
  /** 尾部元信息：git 相对时间。 */
  meta?: LooseOptional<string>
  /** 版本时间戳（ms）：本地=savedAt，git=authoredAt；用于时间线按时间段着色。 */
  timestamp?: LooseOptional<number>
  /** 定点特殊节点（最新版本 = 当前/HEAD），时间线渲染成靶心。 */
  special?: boolean
}

export interface WorkbenchFileHistorySource {
  records: WorkbenchFileHistoryRecord[]
  isLoadingList: boolean
  listError: Nullable<string>
  /** 按 id 读取该版本文件的完整内容（本地=快照，git=`git show sha:path`，path 是文件在那个提交里的路径）。 */
  loadContent: (id: string) => Promise<string>
}

/**
 * 本地历史与 Git 历史的统一数据源：两种模式产出同一套 records + loadContent，
 * 让面板对「时间线 / 内容 / 差异 / 搜索」走同一条渲染路径。
 */
export function useWorkbenchFileHistory({
  mode,
  projectRoot,
  path,
  locale,
  enabled,
}: {
  mode: WorkbenchFileHistoryMode
  projectRoot: string
  path: Nullable<string>
  locale: AppLocale
  enabled: boolean
}): WorkbenchFileHistorySource {
  const hostRuntime = useWorkbenchHostRuntime()
  const [records, setRecords] = useState<WorkbenchFileHistoryRecord[]>([])
  const [isLoadingList, setIsLoadingList] = useState(false)
  const [listError, setListError] = useState<Nullable<string>>(null)
  const generationRef = useRef(0)
  /** Git 历史里每个提交时文件的路径：改名之前的提交要按旧路径读。 */
  const gitPathsRef = useRef<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    if (!enabled || !path) {
      setRecords([])
      setListError(null)
      return
    }

    const generation = ++generationRef.current
    gitPathsRef.current = new Map()
    setIsLoadingList(true)
    setListError(null)

    void (async () => {
      try {
        if (mode === 'local') {
          const nextRecords = await loadLocalRecords(hostRuntime, projectRoot, path, locale)
          if (generation !== generationRef.current) return
          setRecords(nextRecords)
          return
        }
        const git = await loadGitRecords(hostRuntime, projectRoot, path, locale)
        if (generation !== generationRef.current) return
        gitPathsRef.current = git.paths
        setRecords(git.records)
      } catch (error) {
        if (generation !== generationRef.current) return
        setRecords([])
        setListError(AppError.getMessage(error))
      } finally {
        if (generation === generationRef.current) setIsLoadingList(false)
      }
    })()
  }, [enabled, hostRuntime, locale, mode, path, projectRoot])

  const loadContent = useCallback(
    async (id: string): Promise<string> => {
      if (!path) return ''
      if (mode === 'local') {
        const result = Result.unwrap(
          await hostRuntime.kernel.project.readWorkbenchLocalHistorySnapshot({ projectRoot, path, id })
        )
        return result.content
      }
      const result = Result.unwrap(
        await hostRuntime.kernel.workspace.getWorkspaceGitFileAtCommit(projectRoot, {
          commitSha: id,
          path: gitPathsRef.current.get(id) ?? path,
        })
      )
      return result.content
    },
    [hostRuntime, mode, path, projectRoot]
  )

  return { records, isLoadingList, listError, loadContent }
}

async function loadLocalRecords(
  hostRuntime: WorkbenchHostRuntime,
  projectRoot: string,
  path: string,
  locale: AppLocale
): Promise<WorkbenchFileHistoryRecord[]> {
  const result = Result.unwrap(
    await hostRuntime.kernel.project.listWorkbenchLocalHistory({ projectRoot, path })
  )
  return result.entries.map((entry, index) => ({
    id: entry.id,
    title: new Date(entry.savedAt).toLocaleString(locale),
    timestamp: entry.savedAt,
    special: index === 0,
  }))
}

async function loadGitRecords(
  hostRuntime: WorkbenchHostRuntime,
  projectRoot: string,
  path: string,
  locale: AppLocale
): Promise<{ records: WorkbenchFileHistoryRecord[]; paths: ReadonlyMap<string, string> }> {
  const result = Result.unwrap(
    await hostRuntime.kernel.workspace.getWorkspaceGitLog(projectRoot, {
      path,
      limit: GIT_HISTORY_COMMIT_LIMIT,
    })
  )
  return {
    records: result.commits.map((commit, index) => ({
      id: commit.sha,
      title: commit.subject,
      subtitle: commit.authorName,
      meta: formatWorkbenchGitCommitDate(locale, commit),
      timestamp: commit.authoredAt,
      special: index === 0,
    })),
    paths: new Map(result.commits.map((commit) => [commit.sha, commit.path ?? path])),
  }
}
