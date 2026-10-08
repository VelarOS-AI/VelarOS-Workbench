import { type ReactElement } from 'react'
import { ChatCircleTextIcon } from '@phosphor-icons/react'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import type { WorkbenchAgentEngineId } from '@shared/workbenchConversation'

import { useWorkbenchChatProjectRuntime } from '../composition/WorkbenchChatProvider'
import { WorkbenchAgentEngineBrandIcon } from '../runtime/conversation/WorkbenchAgentEngineBrandIcon'
import { useWorkbenchAgentEngines, workbenchAgentEngineLabel } from '../runtime/workbenchAgentEngines'
import styles from '../styles/workbenchPageStyles'

export function WorkbenchAgentRail({
  projectRoot,
  isOpen,
  onOpen,
  onToggle,
}: {
  projectRoot: string
  isOpen: boolean
  onOpen: () => void
  onToggle: () => void
}): ReactElement {
  const chat = useWorkbenchChatProjectRuntime(projectRoot)
  const engines = useWorkbenchAgentEngines()
  const activeEngine = chat.currentSession.engine?.id ?? null
  const engineIds = new Set([
    ...engines.filter((engine) => engine.problem !== 'missing').map((engine) => engine.id),
    ...chat.sessions.flatMap((session) => session.engine ? [session.engine.id] : []),
  ])
  const select = (engineId: Nullable<WorkbenchAgentEngineId>): void => {
    if (activeEngine === engineId) onToggle()
    else {
      chat.actions.openAgentChat(engineId)
      onOpen()
    }
  }
  return <>
    <IconButton
      variant="ghost"
      size="icon-sm"
      className={styles.rightToolButton}
      title="Workbench Agent"
      label="Workbench Agent"
      data-active={isOpen && activeEngine === null}
      onClick={() => select(null)}
    >
      <ChatCircleTextIcon size={18} weight="duotone" />
    </IconButton>
    {[...engineIds].map((id) => (
      <IconButton
        key={id}
        variant="ghost"
        size="icon-sm"
        className={styles.rightToolButton}
        title={workbenchAgentEngineLabel(id)}
        label={workbenchAgentEngineLabel(id)}
        data-agent-engine={id}
        data-active={isOpen && activeEngine === id}
        onClick={() => select(id)}
      >
        <WorkbenchAgentEngineBrandIcon engineId={id} />
      </IconButton>
    ))}
  </>
}
