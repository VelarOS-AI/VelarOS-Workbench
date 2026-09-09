import { type ReactElement, useState } from 'react'
import {
  CheckCircleIcon,
  ClockIcon,
  SpinnerGapIcon,
  StopCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'

import type { ConversationWorkerThread } from '@velaros-ai/ui/conversation'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import { useWorkbenchI18n } from '../../i18n'
import styles from '../../styles/workbenchPageStyles'

/**
 * 子 Agent 线程的**折叠形态**。
 *
 * Desktop 把 worker thread 画成侧栏（宽、能常驻、点开是一条独立时间线）；Workbench 的会话本身
 * 就是一条窄侧栏，再嵌一层侧栏没有地方放。这里换成与工具卡同族的折叠卡：默认只占一行，
 * 展开后就地显示这条线程的输入与结论——形态不同，信息一条不少。
 *
 * 面板不带停止/引导按钮：那两件事要 renderer→main 的 worker 控制 IPC，Workbench 目前只在
 * 整轮粒度上提供停止（会话头部的停止按钮会连同子 Agent 一起中止）。少一个按钮，好过放一个
 * 点了没反应的按钮。
 */
export function WorkbenchWorkerThreadPanel({
  threads,
}: {
  threads: readonly ConversationWorkerThread[]
}): Nullable<ReactElement> {
  if (threads.length === 0) return null

  return (
    <div className={styles.workbenchWorkerThreadPanel}>
      {threads.map((thread) => (
        <WorkbenchWorkerThreadCard key={thread.activationId ?? thread.threadId} thread={thread} />
      ))}
    </div>
  )
}

function WorkbenchWorkerThreadCard({
  thread,
}: {
  thread: ConversationWorkerThread
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const running = isWorkerThreadRunning(thread)
  const body = thread.error ?? thread.output ?? thread.summary ?? null

  return (
    <ToolDisclosureCard
      statusTone={resolveWorkerThreadTone(thread)}
      statusIcon={renderWorkerThreadStatusIcon(thread)}
      title={thread.customAgentName ?? thread.agentName ?? thread.title}
      subtitle={
        <Text tone="caption" className={styles.workbenchWorkerThreadSubtitle}>
          {[
            thread.subagentType,
            thread.model,
            running ? t('workbench.workerThreadRunning') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      }
      open={open}
      showCaret={!!body || !!thread.input}
      onOpenChange={body || thread.input ? setOpen : undefined}
      contentMaxHeight={320}
    >
      {open && (
        <div className={styles.workbenchWorkerThreadBody}>
          {!!thread.input && (
            <Text tone="caption" className={styles.workbenchWorkerThreadInput}>
              {thread.input}
            </Text>
          )}
          {!!body && <Text className={styles.workbenchWorkerThreadOutput}>{body}</Text>}
        </div>
      )}
    </ToolDisclosureCard>
  )
}

function resolveWorkerThreadTone(
  thread: ConversationWorkerThread
): 'neutral' | 'running' | 'success' | 'error' {
  if (thread.status === 'completed') return 'success'
  if (thread.status === 'failed') return 'error'
  if (thread.status === 'aborted') return 'neutral'
  return isWorkerThreadRunning(thread) ? 'running' : 'neutral'
}

function isWorkerThreadRunning(thread: ConversationWorkerThread): boolean {
  return thread.status === 'running'
    || thread.status === 'pending'
    || thread.status === 'awaiting_confirmation'
    || thread.status === 'awaiting_input'
}

function renderWorkerThreadStatusIcon(thread: ConversationWorkerThread): ReactElement {
  if (thread.status === 'completed') return <CheckCircleIcon size={14} weight="bold" />
  if (thread.status === 'failed') return <XCircleIcon size={14} weight="bold" />
  if (thread.status === 'aborted') return <StopCircleIcon size={14} weight="bold" />
  if (thread.status === 'awaiting_confirmation' || thread.status === 'awaiting_input') return <ClockIcon size={14} weight="bold" />
  return <SpinnerGapIcon size={14} className={styles.spinIcon} />
}
