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

export function useWorkbenchAgentEnginesContributionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let active = true
    const apply = (catalog: Awaited<ReturnType<
      typeof window.velarosWorkbenchAgentMods.list
    >>): void => {
      const mod = catalog.mods.find((candidate) => candidate.id === 'velaros.agent-engines')
      if (active) setEnabled(mod?.enabled ?? false)
    }
    void window.velarosWorkbenchAgentMods.list().then(apply)
    const unsubscribe = window.velarosWorkbenchAgentMods.onChanged(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return enabled
}
