import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { Log } from '@velaros-ai/velaros/core'

import { type WorkbenchDirectoryEntry } from '@shared/contracts/workbench'

import { useWorkbenchHostRuntime } from '../../host/WorkbenchHostProvider'
import { useWorkbenchI18n } from '../../i18n/WorkbenchLocalizationProvider'
import {
  buildPackageScriptCommandSuggestions,
  inferPackageManagerCommand,
  type WorkbenchCommandSuggestion,
} from '../../models/commands/workbenchCommandSuggestions'
import { buildWorkbenchProjectToolSuggestions } from '../../models/commands/workbenchProjectToolSuggestions'
import type { WorkbenchProject } from '../../models/project/workbenchProjects'

const log = Log.tag('workbench-command-suggestions')

interface UseWorkbenchCommandSuggestionsOptions {
  activeProject: Nullable<WorkbenchProject>
  rootEntries: WorkbenchDirectoryEntry[]
  rootEntrySignature: string
  activeProjectRef: MutableRefObject<Nullable<WorkbenchProject>>
  setCommandSuggestions: Dispatch<SetStateAction<WorkbenchCommandSuggestion[]>>
  setCommandInput: Dispatch<SetStateAction<string>>
}

export function useWorkbenchCommandSuggestions({
  activeProject,
  rootEntries,
  rootEntrySignature,
  activeProjectRef,
  setCommandSuggestions,
  setCommandInput,
}: UseWorkbenchCommandSuggestionsOptions): void {
  const hostRuntime = useWorkbenchHostRuntime()
  const { t } = useWorkbenchI18n()
  useEffect(() => {
    let permitted = true
    async function loadCommandSuggestions(): Promise<void> {
      if (!activeProject) {
        setCommandSuggestions((current) => (current.length === 0 ? current : []))
        return
      }

      const { id: owningProjectId, rootPath } = activeProject
      async function readManifest(path: string): Promise<string | null> {
        if (!permitted) return null
        const result = await hostRuntime.kernel.project.readWorkbenchFile({
          projectRoot: rootPath,
          path,
          maxChars: 100_000,
        })
        return result.ok ? result.data.content : null
      }

      try {
        const [packageJson, toolSuggestions] = await Promise.all([
          rootEntries.some((entry) => entry.type === 'file' && entry.name === 'package.json')
            ? readManifest('package.json')
            : null,
          buildWorkbenchProjectToolSuggestions(rootEntries, readManifest, (kind, name) =>
            t(kind === 'dev' ? 'workbench.projectToolStart' : 'workbench.projectToolBuild', {
              name,
            })
          ),
        ])

        if (!permitted || activeProjectRef.current?.id !== owningProjectId) return

        const packageSuggestions =
          packageJson === null
            ? []
            : buildPackageScriptCommandSuggestions(
                packageJson,
                inferPackageManagerCommand(rootEntries)
              )

        setCommandSuggestions([...packageSuggestions, ...toolSuggestions])
        setCommandInput((current) => current || packageSuggestions[0]?.command || '')
      } catch (error) {
        if (!permitted || activeProjectRef.current?.id !== owningProjectId) return

        log.debug('读取项目命令建议失败，清空建议列表', {
          projectId: owningProjectId,
          rootPath: activeProject.rootPath,
          error: String(error),
        })
        setCommandSuggestions((current) => (current.length === 0 ? current : []))
      }
    }

    void loadCommandSuggestions()
    return () => {
      permitted = false
    }
  }, [
    activeProject?.id,
    activeProject?.rootPath,
    activeProjectRef,
    hostRuntime,
    rootEntrySignature,
    setCommandInput,
    setCommandSuggestions,
    t,
  ])
}
