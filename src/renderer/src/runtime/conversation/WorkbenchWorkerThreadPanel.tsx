import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  CheckCircleIcon,
  ClockIcon,
  SpinnerGapIcon,
  StopCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'

import {
  ChatTranscript,
  type ConversationWorkerThread,
  type FileChangeSummaryListEntry,
} from '@velaros-ai/ui/conversation'
import type { ChatMessage } from '@velaros-ai/ui/conversation/contracts'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { ToolDisclosureCard } from '@velaros-ai/ui/product/layout/ToolDisclosureCard'

import { useWorkbenchI18n } from '../../i18n/WorkbenchLocalizationProvider'
import styles from '../../styles/workbenchPageStyles'

/** 卡片里嵌的时间线与聊天页落到同一组宿主入口：项目根、打开路径、文件改动。 */
export interface WorkbenchWorkerThreadScope {
  readonly projectRoot: string
  readonly onOpenProjectPath?: (path: string) => unknown
  readonly onOpenFileChange?: (entry: FileChangeSummaryListEntry) => void | Promise<void>
  readonly onReviewFileChanges?: (entries: FileChangeSummaryListEntry[]) => void | Promise<void>
}

export const WorkbenchWorkerThreadScopeContext =
  createContext<Nullable<WorkbenchWorkerThreadScope>>(null)

/** 离底部这么近就算「在看最新」：新输出进来时跟着滚。 */
const StickToBottomThresholdPx = 24

/**
 * 子 Agent 线程的**折叠形态**。
 *
 * Desktop 把 worker thread 画成侧栏（宽、能常驻、点开是一条独立时间线）；Workbench 的会话本身
 * 就是一条窄侧栏，再嵌一层侧栏没有地方放。这里换成与工具卡同族的折叠卡：默认只占一行，展开后
 * 就地显示任务说明与这条线程的完整时间线——文字、思考、工具调用用聊天页同一套消息渲染。
 *
 * 面板不带停止/引导按钮：那两件事要 renderer→main 的 worker 控制 IPC，Workbench 目前只在
 * 整轮粒度上提供停止（会话头部的停止按钮会连同子 Agent 一起中止）。少一个按钮，好过放一个
 * 点了没反应的按钮。
 */
export function WorkbenchWorkerThreadPanel({
  threads,
  sessionId,
}: {
  threads: readonly ConversationWorkerThread[]
  sessionId: string
}): Nullable<ReactElement> {
  if (threads.length === 0) return null

  return (
    <div className={styles.workbenchWorkerThreadPanel}>
      {threads.map((thread) => (
        <WorkbenchWorkerThreadCard
          key={thread.activationId ?? thread.threadId}
          thread={thread}
          sessionId={sessionId}
        />
      ))}
    </div>
  )
}

function WorkbenchWorkerThreadCard({
  thread,
  sessionId,
}: {
  thread: ConversationWorkerThread
  sessionId: string
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [open, setOpen] = useState(false)
  const running = isWorkerThreadRunning(thread)
  const hasTimeline = thread.messages.length > 0
  // 还没有时间线（刚派出的乐观占位、旧事件）时退回派发器给的结论或说明。
  const fallbackBody = thread.error ?? thread.output ?? thread.summary ?? null
  const expandable = hasTimeline || !!fallbackBody || !!thread.input
  const caption = [
    thread.subagentType,
    thread.model,
    running ? t('workbench.workerThreadRunning') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <ToolDisclosureCard
      statusTone={resolveWorkerThreadTone(thread)}
      statusIcon={renderWorkerThreadStatusIcon(thread)}
      // 名字与类型、模型、状态排在同一行：卡片折叠时只占一行。
      title={
        <span className={styles.workbenchWorkerThreadTitle}>
          <span>{thread.customAgentName ?? thread.agentName ?? thread.title}</span>
          {!!caption && (
            <Text tone="caption" className={styles.workbenchWorkerThreadCaption}>
              {caption}
            </Text>
          )}
        </span>
      }
      open={open}
      showCaret={expandable}
      onOpenChange={expandable ? setOpen : undefined}
      // 时间线自己带滚动容器（要跟随最新输出），卡片不再限高另套一层滚动。
      contentMaxHeight="none"
    >
      {open && (
        <div className={styles.workbenchWorkerThreadBody}>
          {!!thread.input && (
            <Text tone="caption" className={styles.workbenchWorkerThreadInput}>
              {thread.input}
            </Text>
          )}
          {hasTimeline ? (
            <WorkbenchWorkerThreadTranscript thread={thread} sessionId={sessionId} running={running} />
          ) : (
            !!fallbackBody && <Text className={styles.workbenchWorkerThreadOutput}>{fallbackBody}</Text>
          )}
        </div>
      )}
    </ToolDisclosureCard>
  )
}

/**
 * 线程时间线：聊天页同一个 ChatTranscript。跑着的时候跟到最新输出，用户往上翻了就不再拽回去；
 * 已结束的从头开始看。
 */
function WorkbenchWorkerThreadTranscript({
  thread,
  sessionId,
  running,
}: {
  thread: ConversationWorkerThread
  sessionId: string
  running: boolean
}): ReactElement {
  const scope = useContext(WorkbenchWorkerThreadScopeContext)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(running)
  const streamingMessageId = running ? thread.messages.at(-1)?.id : undefined
  const getIsStreaming = useCallback(
    (message: ChatMessage) => message.id === streamingMessageId,
    [streamingMessageId]
  )

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight
  }, [thread.messages])

  return (
    <div
      ref={scrollRef}
      className={styles.workbenchWorkerThreadTranscript}
      onScroll={(event) => {
        const element = event.currentTarget
        stickToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= StickToBottomThresholdPx
      }}
    >
      <ChatTranscript
        messages={thread.messages}
        sessionId={`${sessionId}:${thread.activationId ?? thread.threadId}`}
        showToolDetails
        activeProjectRoot={scope?.projectRoot}
        canShowFileChangeSummary={false}
        billingModel={null}
        getIsStreaming={getIsStreaming}
        canRewindToMessage={false}
        onOpenProjectPath={scope?.onOpenProjectPath}
        onOpenFileChange={scope?.onOpenFileChange}
        onReviewFileChanges={scope?.onReviewFileChanges}
      />
    </div>
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
