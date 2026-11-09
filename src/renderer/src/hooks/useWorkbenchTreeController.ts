import { useMemo, useState } from 'react'
import { workbenchHost } from '@renderer/host/WorkbenchHost'
import {
  getWorkbenchPathAncestorDirectories,
  getWorkbenchPathParentDirectory,
} from '@renderer/models/files/workbenchPathModel'
import type { WorkbenchProject } from '@renderer/models/project/workbenchProjects'
import {
  findEntryByPath,
  isSameOrChildPath,
  isWorkbenchTreeRoot,
  ROOT_PATH,
} from '@renderer/models/shared/workbenchUtils'

import { isEmpty } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  type WorkbenchDirectoryEntry,
  type WorkbenchListDirectoryResult,
  type WorkbenchReadFileResult,
} from '@shared/contracts/workbench'

import { useStableWorkbenchMessageTranslate } from '../runtime/useStableWorkbenchMessaging'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

const WORKBENCH_TREE_DIRECTORY_LIMIT = 5000
const WORKBENCH_TREE_DIRECTORY_BATCH_SIZE = 8
const EMPTY_ROOT_ENTRIES: WorkbenchDirectoryEntry[] = []

interface UseWorkbenchTreeControllerOptions {
  activeProject: Nullable<WorkbenchProject>
}

export interface WorkbenchTreeLoadOptions {
  quiet?: boolean
  replace?: boolean
}

export function useWorkbenchTreeController({ activeProject }: UseWorkbenchTreeControllerOptions) {
  const { messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const activeProjectRef = useLatest(activeProject)

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([ROOT_PATH]))
  const [childrenByPath, setChildrenByPath] = useState<Map<string, WorkbenchDirectoryEntry[]>>(
    () => new Map()
  )
  const childrenByPathRef = useLatest(childrenByPath)
  const [selectedEntryPath, setSelectedEntryPath] = useState<Nullable<string>>(null)
  /** 每次定位（`revealEntryPath`）加一：文件树据此把选中项滚进视野，哪怕选中项本来就是它。 */
  const [revealRevision, setRevealRevision] = useState(0)
  const [isLoadingTree, setIsLoadingTree] = useState(false)

  const rootEntries = childrenByPath.get(ROOT_PATH) ?? EMPTY_ROOT_ENTRIES
  const selectedEntry = useMemo(
    () => findEntryByPath(childrenByPath, selectedEntryPath),
    [childrenByPath, selectedEntryPath]
  )

  const discardUnavailableDirectory = useMemoizedFn((path: string): void => {
    if (isWorkbenchTreeRoot({ path })) return

    setExpandedPaths((current) => {
      const next = new Set(current)
      for (const expandedPath of current) {
        if (isSameOrChildPath(expandedPath, path)) next.delete(expandedPath)
      }
      return next
    })
    setChildrenByPath((current) => {
      const next = new Map(current)
      for (const cachedPath of current.keys()) {
        if (isSameOrChildPath(cachedPath, path)) next.delete(cachedPath)
      }

      const parentPath = getWorkbenchPathParentDirectory(path)
      const parentEntries = next.get(parentPath)
      if (parentEntries) {
        next.set(
          parentPath,
          parentEntries.filter((entry) => entry.path !== path)
        )
      }
      return next
    })
    setSelectedEntryPath((current) =>
      current && isSameOrChildPath(current, path) ? null : current
    )
  })

  const requestDirectory = useMemoizedFn(
    async (
      project: WorkbenchProject,
      path: string,
      options: WorkbenchTreeLoadOptions = {}
    ): Promise<Nullable<WorkbenchListDirectoryResult>> => {
      const owningProjectId = project.id

      try {
        const result = Result.unwrap(
          await workbenchHost.kernel.project.listWorkbenchDirectory({
            projectRoot: project.rootPath,
            path,
            includeHidden: true,
            limit: WORKBENCH_TREE_DIRECTORY_LIMIT,
          })
        )

        if (activeProjectRef.current?.id !== owningProjectId) return null

        return result
      } catch (error) {
        if (activeProjectRef.current?.id !== owningProjectId) return null

        const appError = AppError.from(error)
        if (appError.code === 'NOT_FOUND') discardUnavailableDirectory(path)
        if (!options.quiet) {
          messageLatest.current.error({
            title: tLatest.current('workbench.loadDirectoryFailed'),
            description: appError.message,
          })
        }
        return null
      }
    }
  )

  const commitDirectoryResults = useMemoizedFn(
    (results: readonly WorkbenchListDirectoryResult[], replace = false): void => {
      if (isEmpty(results)) return

      setChildrenByPath((current) => {
        const next = replace ? new Map<string, WorkbenchDirectoryEntry[]>() : new Map(current)
        results.forEach((result) => {
          next.set(result.path, result.entries)
          if (result.path === ROOT_PATH) return

          const parentPath = getWorkbenchPathParentDirectory(result.path)
          const parentEntries = next.get(parentPath)
          if (!parentEntries) return

          const hasChildren = !isEmpty(result.entries)
          const entryIndex = parentEntries.findIndex((entry) => entry.path === result.path)
          const entry = parentEntries[entryIndex]
          if (!entry || entry.hasChildren === hasChildren) return

          const nextParentEntries = [...parentEntries]
          nextParentEntries[entryIndex] = { ...entry, hasChildren }
          next.set(parentPath, nextParentEntries)
        })
        return next
      })
    }
  )

  const loadDirectory = useMemoizedFn(
    async (
      project: WorkbenchProject,
      path: string,
      options: WorkbenchTreeLoadOptions = {}
    ): Promise<Nullable<WorkbenchListDirectoryResult>> => {
      const result = await requestDirectory(project, path, options)
      if (result) commitDirectoryResults([result], !!options.replace)
      return result
    }
  )

  const loadDirectoryBatch = useMemoizedFn(
    async (
      project: WorkbenchProject,
      paths: readonly string[],
      options: Pick<WorkbenchTreeLoadOptions, 'quiet'> & { skipCached?: boolean } = {}
    ): Promise<void> => {
      const uniquePaths = [...new Set(paths)].filter(
        (path) => !options.skipCached || !childrenByPathRef.current.has(path)
      )

      for (
        let offset = 0;
        offset < uniquePaths.length;
        offset += WORKBENCH_TREE_DIRECTORY_BATCH_SIZE
      ) {
        const batch = uniquePaths.slice(offset, offset + WORKBENCH_TREE_DIRECTORY_BATCH_SIZE)
        const results = await Promise.all(
          batch.map((path) => requestDirectory(project, path, options))
        )
        if (activeProjectRef.current?.id !== project.id) return

        commitDirectoryResults(
          results.filter((result): result is WorkbenchListDirectoryResult => !!result)
        )
      }
    }
  )

  const loadRootDirectory = useMemoizedFn(async (project: WorkbenchProject): Promise<boolean> => {
    const owningProjectId = project.id

    try {
      setIsLoadingTree(true)
      return !!(await loadDirectory(project, ROOT_PATH, { replace: true }))
    } finally {
      if (activeProjectRef.current?.id === owningProjectId) {
        setIsLoadingTree(false)
      }
    }
  })

  const resetTree = useMemoizedFn((): void => {
    setExpandedPaths(new Set([ROOT_PATH]))
    setChildrenByPath(new Map())
    setSelectedEntryPath(null)
    setIsLoadingTree(false)
  })

  const refreshRootDirectory = useMemoizedFn(async (): Promise<void> => {
    if (!activeProject) return

    await loadRootDirectory(activeProject)
  })

  const refreshLoadedDirectories = useMemoizedFn(async (): Promise<void> => {
    if (!activeProject) return

    const loadedPaths = [...childrenByPathRef.current.keys()]
    if (isEmpty(loadedPaths)) {
      await loadDirectory(activeProject, ROOT_PATH)
      return
    }

    await loadDirectoryBatch(activeProject, loadedPaths, { quiet: true })
  })

  const restoreExpandedPaths = useMemoizedFn(
    async (
      paths: readonly string[],
      options: Pick<WorkbenchTreeLoadOptions, 'quiet'> = {}
    ): Promise<void> => {
      if (!activeProject) return

      const normalized = new Set<string>([ROOT_PATH])
      for (const path of paths) {
        const trimmed = path.trim()
        if (!trimmed) continue
        normalized.add(trimmed)
      }

      setExpandedPaths(normalized)

      const sortedPaths = [...normalized].sort(
        (left, right) => left.split('/').length - right.split('/').length
      )

      await loadDirectoryBatch(
        activeProject,
        sortedPaths.filter((path) => path !== ROOT_PATH),
        { ...options, skipCached: true }
      )
    }
  )

  const toggleDirectory = useMemoizedFn(async (path: string): Promise<void> => {
    if (!activeProject) return

    setSelectedEntryPath(path)
    const isExpanded = expandedPaths.has(path)
    if (isExpanded) {
      if (isWorkbenchTreeRoot({ path })) return
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
      return
    }

    setExpandedPaths((current) => new Set(current).add(path))
    if (!childrenByPath.has(path)) {
      await loadDirectory(activeProject, path)
    }
  })

  const setDirectoryOpen = useMemoizedFn(async (path: string, open: boolean): Promise<void> => {
    if (!activeProject) return

    setSelectedEntryPath(path)
    if (!open) {
      if (isWorkbenchTreeRoot({ path })) return
      setExpandedPaths((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
      return
    }

    setExpandedPaths((current) => new Set(current).add(path))
    if (!childrenByPath.has(path)) {
      await loadDirectory(activeProject, path)
    }
  })

  const openDirectory = useMemoizedFn(async (path: string): Promise<void> => {
    setSelectedEntryPath(path)
    setExpandedPaths((current) => new Set(current).add(path))
    if (activeProject && !childrenByPath.has(path)) {
      await loadDirectory(activeProject, path)
    }
  })

  const revealEntryPath = useMemoizedFn(
    async (path: string, options: Pick<WorkbenchTreeLoadOptions, 'quiet'> = {}): Promise<void> => {
      if (!activeProject) return

      const ancestorDirectories = getWorkbenchPathAncestorDirectories(path)
      setSelectedEntryPath(path)
      setRevealRevision((revision) => revision + 1)
      setExpandedPaths((current) => {
        const next = new Set(current)
        ancestorDirectories.forEach((directoryPath) => next.add(directoryPath))
        return next
      })

      await loadDirectoryBatch(activeProject, ancestorDirectories, {
        ...options,
        skipCached: true,
      })
    }
  )

  const pruneTreeCache = useMemoizedFn((path: string): void => {
    setChildrenByPath((current) => {
      const next = new Map(current)
      for (const key of current.keys()) {
        if (isSameOrChildPath(key, path)) {
          next.delete(key)
        }
      }
      return next
    })
  })

  const refreshMutationParent = useMemoizedFn(async (parentPath: string): Promise<void> => {
    if (!activeProject) return

    setExpandedPaths((current) => new Set(current).add(parentPath))
    await loadDirectory(activeProject, parentPath)
  })

  const refreshTreeFileMetadata = useMemoizedFn((file: WorkbenchReadFileResult): void => {
    setChildrenByPath((current) => {
      const next = new Map(current)

      for (const [directoryPath, entries] of current) {
        let changed = false
        const nextEntries = entries.map((entry) => {
          if (entry.path !== file.path) return entry

          changed = true
          return {
            ...entry,
            size: file.size,
            modifiedAt: file.modifiedAt,
          }
        })

        if (changed) {
          next.set(directoryPath, nextEntries)
        }
      }

      return next
    })
  })

  return {
    rootEntries,
    selectedEntry,
    selectedEntryPath,
    revealRevision,
    expandedPaths,
    childrenByPath,
    isLoadingTree,
    setSelectedEntryPath,
    resetTree,
    loadRootDirectory,
    refreshRootDirectory,
    refreshLoadedDirectories,
    restoreExpandedPaths,
    toggleDirectory,
    setDirectoryOpen,
    openDirectory,
    revealEntryPath,
    pruneTreeCache,
    refreshMutationParent,
    refreshTreeFileMetadata,
  }
}
