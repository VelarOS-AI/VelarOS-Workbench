import { PauseIcon, PlayIcon, TargetIcon, TrashIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { ReactElement } from 'react'

import type { ConversationCardContent } from '@velaros-ai/ui/conversation'
import { ActionCardIconButton } from '@velaros-ai/ui/product/layout/ActionCard'
import { InteractionSuggestionCard } from '@velaros-ai/ui/product/layout/InteractionSuggestionCard'

import styles from './WorkbenchGoalDockCard.module.css'

type GoalLifecycleCardContent = Extract<ConversationCardContent, { kind: 'goal-lifecycle' }>

function getCardTone(
  tone: GoalLifecycleCardContent['model']['tone']
): 'neutral' | 'info' | 'success' | 'warning' | 'error' {
  switch (tone) {
    case 'active':
      return 'info'
    case 'paused':
      return 'warning'
    case 'complete':
      return 'success'
    case 'blocked':
      return 'error'
    case 'cancelled':
      return 'neutral'
  }
}

/**
 * 输入框上方的目标卡（Desktop `GoalDockCard` 的对位件）：当前目标、状态色，以及暂停 / 继续 / 移除。
 * 目标由目标模式或模型的 goal:create 建立，读写都经会话动作端口落到主进程的活动上下文。
 */
export function WorkbenchGoalDockCard({
  model,
  busy,
  onAction,
  onContinue,
}: Omit<GoalLifecycleCardContent, 'kind'>): ReactElement {
  const { t } = useWorkbenchI18n()

  return (
    <InteractionSuggestionCard
      className={styles.card}
      data-goal-status={model.status}
      tone={getCardTone(model.tone)}
      icon={<TargetIcon size={17} weight="bold" />}
      title={t('chat.goalDockTitle')}
      description={
        <span className={styles.description} title={model.objective}>
          {model.objective}
        </span>
      }
      actions={
        <>
          {model.actions.map((action) =>
            action === 'pause' ? (
              <ActionCardIconButton
                key={action}
                label={t('chat.goalDockActionPause')}
                title={t('chat.goalDockActionPause')}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void onAction('pause')
                }}
              >
                <PauseIcon size={15} weight="bold" />
              </ActionCardIconButton>
            ) : action === 'continue' ? (
              <ActionCardIconButton
                key={action}
                label={t('chat.goalDockActionContinue')}
                title={t('chat.goalDockActionContinue')}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation()
                  void onContinue()
                }}
              >
                <PlayIcon size={15} weight="bold" />
              </ActionCardIconButton>
            ) : (
              <ActionCardIconButton
                key={action}
                label={t('chat.goalDockActionRemove')}
                title={t('chat.goalDockActionRemove')}
                disabled={busy}
                tone="danger"
                onClick={(event) => {
                  event.stopPropagation()
                  void onAction('remove')
                }}
              >
                <TrashIcon size={15} weight="bold" />
              </ActionCardIconButton>
            )
          )}
        </>
      }
    />
  )
}
