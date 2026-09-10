import { type ReactElement, type ReactNode } from 'react'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'

import type { ConversationRenderSlots } from '@velaros-ai/ui/conversation'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { RenderErrorBoundary } from '@velaros-ai/ui/primitives/display/RenderErrorBoundary'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from './WorkbenchMessageRenderFailure.module.css'

type ChatMessage = Parameters<ConversationRenderSlots['renderMessageBoundary']>[0]['message']

/**
 * 单条消息的渲染错误边界（Desktop `renderMessageBoundary` 的对位件）。
 *
 * 一条消息渲染抛错时只降级这一条：给出提示、保全原文、可重试；消息内容一变就自动重试。
 * 没有它，任何一条消息的渲染异常都会一路冒泡，把整个会话面板卸掉。
 */
export function WorkbenchMessageRenderBoundary({
  message,
  children,
}: {
  message: ChatMessage
  children: ReactNode
}): ReactElement {
  return (
    <RenderErrorBoundary
      scope="workbench-chat-message"
      resetKeys={[message]}
      fallback={(_error, reset) => (
        <WorkbenchMessageRenderFailure message={message} onRetry={reset} />
      )}
    >
      {children}
    </RenderErrorBoundary>
  )
}

function WorkbenchMessageRenderFailure({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry: () => void
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const degradedText = message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()

  return (
    <div className={styles.root} role="alert" data-workbench-message-render-failure="true">
      <div className={styles.header}>
        <WarningCircleIcon size={14} className={styles.icon} />
        <Text className={styles.title}>{t('workbench.chatMessageRenderFailed')}</Text>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('workbench.chatMessageRenderRetry')}
        </Button>
      </div>
      {degradedText && <pre className={styles.degradedText}>{degradedText}</pre>}
    </div>
  )
}
