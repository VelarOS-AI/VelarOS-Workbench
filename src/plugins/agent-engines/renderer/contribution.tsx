import { type ReactElement, useEffect, useState } from 'react'
import type { WorkbenchRightToolWindow } from '@renderer/models/layout/workbenchSurfaceModel'

import { WorkbenchAgentEngineBrandIcon } from './WorkbenchAgentEngineBrandIcon'

export interface WorkbenchAgentEngineRightToolContribution {
  readonly id: WorkbenchRightToolWindow
  readonly label: string
  readonly icon: ReactElement
}

export const WorkbenchAgentEnginesRendererContribution: readonly WorkbenchAgentEngineRightToolContribution[] =
  Object.freeze([
    {
      id: 'claude',
      label: 'Claude',
      icon: <WorkbenchAgentEngineBrandIcon engineId="claude-code" />,
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      icon: <WorkbenchAgentEngineBrandIcon engineId="codex" />,
    },
  ])

export function useWorkbenchAgentPluginContributions(): readonly WorkbenchAgentEngineRightToolContribution[] {
  const [enabledIds, setEnabledIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let active = true
    const apply = (catalog: Awaited<ReturnType<
      typeof window.velarosWorkbenchResourcePlugins.list
    >>): void => {
      if (!active) return
      setEnabledIds(new Set(
        catalog.plugins
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.id)
      ))
    }
    void window.velarosWorkbenchResourcePlugins.list().then(apply)
    const unsubscribe = window.velarosWorkbenchResourcePlugins.onChanged(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return WorkbenchAgentEnginesRendererContribution.filter((contribution) =>
    enabledIds.has(contribution.id === 'claude' ? 'claude-agent' : 'codex-agent')
  )
}
