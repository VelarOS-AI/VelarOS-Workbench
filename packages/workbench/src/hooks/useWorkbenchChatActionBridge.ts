import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentDeveloperContext, AgentSurfaceId, ChatMessage } from '@velaros-ai/core/types'

import { buildWorkbenchActionRunResultEvidence } from '../models/actions/workbenchActionResultEvidence'
import {
  markWorkbenchActionRunDispatched,
  markWorkbenchActionRunFinished,
} from '../models/actions/workbenchActionRuns'
import {
  takeWorkbenchChatDraftHandoff,
  WORKBENCH_CHAT_DRAFT_HANDOFF_STORAGE_KEY,
  type WorkbenchChatDraftHandoff,
} from '../models/actions/workbenchChatDraftHandoff'

interface WorkbenchChatActionRuntimeSnapshot {
  status: string
  lastError: Nullable<string>
  lastRunFinishedAt: Nullable<number>
}

interface UseWorkbenchChatActionBridgeOptions {
  messages: ChatMessage[]
  onDraftHandoff: (prompt: string) => void
  onScopedDraftHandoff?: (handoff: WorkbenchChatDraftHandoff) => boolean
  runtime: WorkbenchChatActionRuntimeSnapshot
  sessionId: string
}

interface WorkbenchChatActionBridge {
  markActionRunDispatched: (actionRunId: string) => void
  pendingActionRunId: Nullable<string>
  pendingAgentSurfaceId: Nullable<AgentSurfaceId>
  pendingDeveloperContext: Nullable<AgentDeveloperContext>
  setPendingActionRunId: (actionRunId: Nullable<string>) => void
  setPendingAgentSurfaceId: (agentSurfaceId: Nullable<AgentSurfaceId>) => void
  setPendingDeveloperContext: (developerContext: Nullable<AgentDeveloperContext>) => void
}

function useLatestValue<T>(value: T): { current: T } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export function useWorkbenchChatActionBridge({
  messages,
  onDraftHandoff,
  onScopedDraftHandoff,
  runtime,
  sessionId,
}: UseWorkbenchChatActionBridgeOptions): WorkbenchChatActionBridge {
  const [pendingActionRunId, setPendingActionRunId] = useState<Nullable<string>>(null)
  const [pendingAgentSurfaceId, setPendingAgentSurfaceId] = useState<Nullable<AgentSurfaceId>>(null)
  const [pendingDeveloperContext, setPendingDeveloperContext] =
    useState<Nullable<AgentDeveloperContext>>(null)
  const [activeActionRunId, setActiveActionRunId] = useState<Nullable<string>>(null)
  const onDraftHandoffLatest = useLatestValue(onDraftHandoff)
  const onScopedDraftHandoffLatest = useLatestValue(onScopedDraftHandoff)

  const consumeDraftHandoff = useCallback((): void => {
    const handoff = takeWorkbenchChatDraftHandoff()
    if (!handoff) return

    if (handoff.projectRoot && onScopedDraftHandoffLatest.current?.(handoff)) return

    onDraftHandoffLatest.current(handoff.prompt)
    setPendingActionRunId(handoff.actionRunId)
    setPendingAgentSurfaceId(handoff.agentSurfaceId)
    setPendingDeveloperContext(handoff.developerContext)
  }, [])

  useEffect(() => {
    consumeDraftHandoff()
  }, [consumeDraftHandoff])

  useEffect(() => {
    const handleWorkbenchChatDraftStorage = (event: StorageEvent): void => {
      if (event.key === WORKBENCH_CHAT_DRAFT_HANDOFF_STORAGE_KEY && event.newValue) {
        consumeDraftHandoff()
      }
    }
    globalThis.addEventListener('storage', handleWorkbenchChatDraftStorage)
    return () => globalThis.removeEventListener('storage', handleWorkbenchChatDraftStorage)
  }, [consumeDraftHandoff])

  useEffect(() => {
    if (!activeActionRunId || !runtime.lastRunFinishedAt) return

    if (!['completed', 'failed', 'aborted'].includes(runtime.status)) return

    const latestAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const isCompleted = runtime.status === 'completed'
    const resultEvidence = buildWorkbenchActionRunResultEvidence(
      latestAssistantMessage,
      runtime.lastError
    )
    markWorkbenchActionRunFinished(activeActionRunId, {
      status: isCompleted ? 'completed' : 'failed',
      resultStatus: runtime.status,
      resultSummary: resultEvidence.resultSummary,
      resultDetails: resultEvidence.resultDetails,
      changedFiles: resultEvidence.changedFiles,
      verificationEvidence: resultEvidence.verificationEvidence,
    })
    setActiveActionRunId(null)
  }, [activeActionRunId, messages, runtime.lastError, runtime.lastRunFinishedAt, runtime.status])

  const markActionRunDispatched = useCallback(
    (actionRunId: string): void => {
      markWorkbenchActionRunDispatched(actionRunId, sessionId)
      setActiveActionRunId(actionRunId)
    },
    [sessionId]
  )

  return {
    markActionRunDispatched,
    pendingActionRunId,
    pendingAgentSurfaceId,
    pendingDeveloperContext,
    setPendingActionRunId,
    setPendingAgentSurfaceId,
    setPendingDeveloperContext,
  }
}
