import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { Log } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import { useWorkbenchHostRuntime } from '../../host'
import {
  buildPackageScriptCommandSuggestions,
  inferPackageManagerCommand,
  type WorkbenchCommandSuggestion,
} from '../../models/commands/workbenchCommandSuggestions'
import type { WorkbenchProject } from '../../models/project/workbenchProjects'

const log = Log.tag('workbench-command-package-suggestions')

interface UseWorkbenchCommandPackageSuggestionsOptions {
  activeProject: Nullable<WorkbenchProject>
  rootEntries: WorkbenchDirectoryEntry[]
  rootEntrySignature: string
  activeProjectRef: MutableRefObject<Nullable<WorkbenchProject>>
  setCommandSuggestions: Dispatch<SetStateAction<WorkbenchCommandSuggestion[]>>
  setCommandInput: Dispatch<SetStateAction<string>>
}

export function useWorkbenchCommandPackageSuggestions({
  activeProject,
  rootEntries,
  rootEntrySignature,
  activeProjectRef,
  setCommandSuggestions,
  setCommandInput,
}: UseWorkbenchCommandPackageSuggestionsOptions): void {
  const hostRuntime = useWorkbenchHostRuntime()
  useEffect(() => {
    async function loadCommandSuggestions(): Promise<void> {
      if (
        !activeProject ||
        !rootEntries.some((entry) => entry.type === 'file' && entry.name === 'package.json')
      ) {
        setCommandSuggestions((current) => (current.length === 0 ? current : []))
        return
      }

      const owningProjectId = activeProject.id

      try {
        const packageJson = Result.unwrap(
          await hostRuntime.kernel.project.readWorkbenchFile({
            projectRoot: activeProject.rootPath,
            path: 'package.json',
            maxChars: 80_000,
          })
        )

        if (activeProjectRef.current?.id !== owningProjectId) return

        const suggestions = buildPackageScriptCommandSuggestions(
          packageJson.content,
          inferPackageManagerCommand(rootEntries)
        )

        setCommandSuggestions(suggestions)
        setCommandInput((current) => current || suggestions[0]?.command || '')
      } catch (error) {
        log.debug('读取 package.json 命令建议失败，清空建议列表', {
          projectId: owningProjectId,
          rootPath: activeProject.rootPath,
          error: String(error),
        })
        if (activeProjectRef.current?.id !== owningProjectId) return

        setCommandSuggestions((current) => (current.length === 0 ? current : []))
      }
    }

    void loadCommandSuggestions()
  }, [
    activeProject?.id,
    activeProject?.rootPath,
    activeProjectRef,
    hostRuntime,
    rootEntrySignature,
    setCommandInput,
    setCommandSuggestions,
  ])
}
