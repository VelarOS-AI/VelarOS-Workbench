import { Result } from '@velaros-ai/core/result'
import type { ConversationComposerPort } from '@velaros-ai/ui/conversation/composer'

import { workbenchMessage } from '../workbenchMessageHost'

/**
 * Workbench 的会话输入区宿主端口。
 *
 * 此前这里直接塞的是包内的 `emptyConversationComposerPort`——那是给组件目录预览用的空壳，
 * 拿它当产品实现有两个可见后果：提示整条静默（输入区的告警根本不出现），以及运行模式只剩两档。
 */
export const standaloneWorkbenchComposerPort: ConversationComposerPort = {
  /**
   * 运行模式的第三档（扩展）在 Desktop 那边挂着云端实验开关，Workbench 没有这层门槛。
   *
   * 三档描述的是上下文治理允许长期携带多少，对本地 BYOK 执行栈全部是正式能力；关掉第三档
   * 只会让滑块少一格、用户永远选不到它，而不会让任何东西更安全。
   */
  experimentalFeaturesEnabled: true,
  /**
   * 本地语音转写与麦克风权限归 whisper 插件，Workbench 尚未装配它。
   *
   * 这里如实返回「拿不到权限」而不是假装成功：组件据此把麦克风入口收起来，
   * 好过点下去毫无反应。
   */
  transcribeLocalSpeech: () => Promise.resolve(Result.ok({ text: '' })),
  requestMicrophonePermission: () => Promise.resolve(Result.ok('denied')),
  openMicrophoneSettings: () => Promise.resolve(),
  notify: {
    warning: (options) => workbenchMessage.warning(options),
    error: (options) => workbenchMessage.error(options),
  },
}
