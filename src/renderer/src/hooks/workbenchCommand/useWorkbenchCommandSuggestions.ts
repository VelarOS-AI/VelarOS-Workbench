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
      const ownsProject = (): boolean =>
        permitted && activeProjectRef.current?.id === owningProjectId
      let packageSuggestions: WorkbenchCommandSuggestion[] = []
      let toolSuggestions: WorkbenchCommandSuggestion[] = []
      const publishTools = (suggestions: WorkbenchCommandSuggestion[]): void => {
        toolSuggestions = suggestions
        if (ownsProject()) setCommandSuggestions([...packageSuggestions, ...toolSuggestions])
      }
      async function readManifest(path: string): Promise<string | null> {
        if (!ownsProject()) return null
        const result = await hostRuntime.kernel.project.readWorkbenchFile({
          projectRoot: rootPath,
          path,
          maxChars: 100_000,
        })
        return result.ok ? result.data.content : null
      }
      async function loadPackageSuggestions(): Promise<void> {
        if (!rootEntries.some((entry) => entry.type === 'file' && entry.name === 'package.json'))
          return
        const content = await readManifest('package.json')
        if (content === null || !ownsProject()) return
        packageSuggestions = buildPackageScriptCommandSuggestions(
          content,
          inferPackageManagerCommand(rootEntries)
        )
        publishTools(toolSuggestions)
        setCommandInput((current) => current || packageSuggestions[0]?.command || '')
      }

      try {
        await Promise.all([
          loadPackageSuggestions(),
          buildWorkbenchProjectToolSuggestions(
            rootEntries,
            readManifest,
            (kind, name) =>
              t(kind === 'dev' ? 'workbench.projectToolStart' : 'workbench.projectToolBuild', {
                name,
              }),
            publishTools
          ).then(publishTools),
        ])
      } catch (error) {
        if (!ownsProject()) return
        log.debug('读取项目命令建议失败', {
          projectId: owningProjectId,
          rootPath: activeProject.rootPath,
          error: String(error),
        })
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
