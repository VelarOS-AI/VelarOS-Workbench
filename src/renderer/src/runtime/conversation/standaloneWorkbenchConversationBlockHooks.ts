import { useCallback, useMemo } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

import {
  type ConversationActionItem,
  type ConversationBlockHooks,
  extractChatActionItems,
} from '@velaros-ai/ui/conversation'

import {
  formatWorkbenchChatPathForDisplay,
  resolveWorkbenchChatAbsolutePath,
} from '../../models/chat/workbenchChatWorkspacePath'
import { workbenchMessage } from '../workbenchMessageHost'

type MessageActionOptions = Parameters<ConversationBlockHooks['useMessageActionView']>[0]
type MessageActionView = ReturnType<ConversationBlockHooks['useMessageActionView']>

/**
 * 每条回答的「消息动作」（Desktop useChatMessageActionViewModel 的对位件）：
 *
 * - 回答正文里的路径是工作区导航——宿主给了编辑器入口就只走它，不降级给系统默认应用；
 * - 回答下方的产物行（移动、打开、删除过的文件）先交给编辑器，编辑器接不住（项目之外）再交给系统
 *   打开或在访达中显示；
 * - 项目根之内的绝对路径一律显示成相对路径。
 */
function useWorkbenchMessageActionView({
  activeProjectRoot,
  message,
  onOpenProjectPath,
}: MessageActionOptions): MessageActionView {
  const { t } = useWorkbenchI18n()
  const projectRoot = activeProjectRoot?.trim() ?? ''
  const actionItems = useMemo(() => extractChatActionItems(message), [message])
  const formatPathForDisplay = useCallback(
    (path: string) => formatWorkbenchChatPathForDisplay(path, projectRoot),
    [projectRoot]
  )
  const openWithSystem = useCallback(
    async (path: string, reveal: boolean): Promise<void> => {
      const hub = window.velarosWorkbenchProjectHub
      const result = await (reveal ? hub.revealSystemPath(path) : hub.openSystemPath(path)).catch(
        (error: unknown) => ({
          opened: false,
          error: error instanceof Error ? error.message : String(error),
        })
      )
      if (!result.opened)
        workbenchMessage.error({
          title: t('chat.fileChangeOpenErrorTitle'),
          description: result.error ?? path,
        })
    },
    [t]
  )
  const openPathInLight = useCallback(
    async (path: string): Promise<void> => {
      const resolvedPath = resolveWorkbenchChatAbsolutePath(path, projectRoot)
      if (onOpenProjectPath) {
        await onOpenProjectPath(resolvedPath)
        return
      }
      await openWithSystem(resolvedPath, false)
    },
    [onOpenProjectPath, openWithSystem, projectRoot]
  )
  const openActionPath = useCallback(
    async (path: string, reveal: boolean): Promise<void> => {
      const resolvedPath = resolveWorkbenchChatAbsolutePath(path, projectRoot)
      if (onOpenProjectPath && (await onOpenProjectPath(resolvedPath)) !== false) return
      await openWithSystem(resolvedPath, reveal)
    },
    [onOpenProjectPath, openWithSystem, projectRoot]
  )
  const actionRows = useMemo(
    () =>
      actionItems.map((item) => {
        const openPath = item.openPath
        return {
          item,
          displayTitle: openPath
            ? formatPathForDisplay(openPath)
            : item.detail
              ? formatPathForDisplay(item.detail)
              : item.title,
          ...(openPath
            ? {
                onClick: (_target: ConversationActionItem) => void openActionPath(openPath, false),
                onReveal: (_target: ConversationActionItem) => void openActionPath(openPath, true),
              }
            : {}),
        }
      }),
    [actionItems, formatPathForDisplay, openActionPath]
  )

  return {
    actionItems,
    actionRows,
    formatPathForDisplay,
    hasActionItems: actionItems.length > 0,
    openPathInLight,
  }
}

/**
 * 独立 Workbench 的会话 blocks hook 注入面。思考块翻译按产品决定不做，开关恒为关。
 */
export const standaloneWorkbenchConversationBlockHooks: ConversationBlockHooks = {
  useMessageActionView: useWorkbenchMessageActionView,
  useAutoTranslateThinkingEnabled: () => false,
}
