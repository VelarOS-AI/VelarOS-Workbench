import type { ActiveContextArtifact, AppLocale } from '@velaros-ai/ui/conversation/contracts'
import type { GoalState } from '@velaros-ai/velaros/contracts'
import { isNotUndefined } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchConversationContextUsage,
  WorkbenchConversationSendRequest,
  WorkbenchConversationState,
} from '../../shared/workbenchConversation'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type {
  ConversationHostInstructionOptions,
  ConversationInput,
  ConversationModelLimits,
  ConversationProjectRule,
  ConversationSessionEvent,
} from './WorkbenchConversationTypes'

/** 只投递本次用户输入；图片保持真实多模态数据，历史由 Platform 持有。 */
export function toConversationInput(
  request: Pick<WorkbenchConversationSendRequest, 'text' | 'images' | 'inputId'>
): ConversationInput {
  const images = request.images?.map((image, index) => ({
    type: 'image-data' as const,
    data: image.data,
    mediaType: image.mediaType,
    label: image.label?.trim() || `image-${index + 1}`,
  }))
  if (!request.text.trim() && !images?.length)
    throw new AppError('VALIDATION', workbenchMainText('conversation.emptyMessage'))
  return { text: request.text, images, inputId: request.inputId }
}

/**
 * 一次模型请求的上下文占用：分子是服务商报告的输入 token，分母是模型驱动的输入上限（已扣输出预留与
 * 安全余量）。
 */
export function contextUsageFromProvider(input: {
  turn: number
  model: string
  inputTokens: number
  limits: ConversationModelLimits
  timestamp: number
}): WorkbenchConversationContextUsage {
  const usableContextWindow = Math.max(1, input.limits.inputTokens)
  return {
    kind: 'context-usage-estimate',
    turn: input.turn,
    model: input.model,
    estimatedTokens: input.inputTokens,
    contextWindow: input.limits.contextTokens,
    usableContextWindow,
    reservedOutputTokens: input.limits.contextTokens - usableContextWindow,
    percent: (input.inputTokens / usableContextWindow) * 100,
    timestamp: input.timestamp,
    contextWindowEstimated: input.limits.contextWindowEstimated === true,
  }
}

/**
 * Platform 一次用量回报 → 用量遥测。带上这一轮的服务商，回答末尾的约价按它计价；服务商报告了前缀缓存
 * 读写才带上那两个数，没报告就不带（不当成零）。
 */
export function usageTelemetryFromProvider(
  usage: Pick<
    Extract<ConversationSessionEvent, { type: 'usage' }>,
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
  >,
  context: { turn: number; provider?: string; model: string; timestamp: number }
): Extract<WorkbenchConversationState, { kind: 'usage-telemetry' }> {
  const telemetry: Extract<WorkbenchConversationState, { kind: 'usage-telemetry' }> = {
    kind: 'usage-telemetry',
    timestamp: context.timestamp,
    turn: context.turn,
    model: context.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    reasoningTokens: null,
    source: 'provider',
    confidence: 'high',
  }
  if (context.provider) telemetry.provider = context.provider as typeof telemetry.provider
  if (isNotUndefined(usage.cacheReadTokens)) telemetry.cacheReadInputTokens = usage.cacheReadTokens
  if (isNotUndefined(usage.cacheWriteTokens))
    telemetry.cacheWriteInputTokens = usage.cacheWriteTokens
  return telemetry
}

/** 运行完成时的结果：目标在这次运行里改过（建立、完成、受阻、暂停）才带上它现在的状态。 */
export function conversationDone(input: {
  goal: Nullable<GoalState>
  startedAt: number
}): Extract<WorkbenchConversationState, { kind: 'done' }> {
  const done: Extract<WorkbenchConversationState, { kind: 'done' }> = { kind: 'done' }
  if (input.goal && input.goal.updatedAt >= input.startedAt) done.goalStatus = input.goal.status
  return done
}

/** 交给模型的项目规则最多这么多字符；超出的文件整份略去，并说明略去了哪些。 */
const ProjectRulesMaxChars = 32_000

/**
 * 按本次执行模式提供任务说明和回复语言（与 Desktop 同一套，身份换成 IDE 里的编程助手）；项目里有
 * AGENTS.md 之类的 AI 规则文件时原文附上（设置页「AI 规则」列的就是这一份）。
 */
export function buildHostInstructions(options: ConversationHostInstructionOptions): string {
  const language = options.locale === 'en-US' ? 'English' : '简体中文'
  return [
    '你是 VelarOS Workbench（一个 IDE）里的编程助手，工作在用户打开的这个项目里。',
    '交付后仍需运行的开发服务器使用 velaros:console（先发现合同）；先 list 避免重复启动，再 start 并 read 检查就绪。普通 Node/Execa 用于会结束的命令，不要等待常驻服务器退出或用 detached/unref 绕过管理。',
    '围绕项目开发完成代码阅读、修改、构建、测试与调试；浏览器和网页检索用于开发资料与界面验收。',
    '普通文件读写用 Node 标准库；需要冲突保护和撤回时发现 velaros:project，一次 commit 提交 changes，before 可复用已读原文或 Buffer，oldText/newText 用于唯一片段替换。搜索结果按定位分页，需要时再读对应片段。',
    '按改动影响范围验证：先运行直接相关的检查，接口、跨模块或共享状态变化再扩大范围；检查通过且没有新改动或未解决问题时，不重复全量检查。交付说明实际完成的验证与剩余缺口。',
    '含内嵌 JavaScript 或正则的大段 HTML 使用当前执行协议的 blobs 原文绑定，经 velaros:program 读取后直接写出；展示前检查最终脚本语法，再在浏览器中验证交互。',
    '派发或续跑子 Agent 时，task 第一行写简短明确的任务标题（约 5—20 字），换行后写目标、文件归属和检查要求；标题不要用角色名、哈希或整段说明。',
    '需要会话协作时先发现 velaros:sessions 并查看当前项目会话；新会话使用 project 工作区和当前项目根。任务说明写清目标、文件归属和验收条件。',
    `面向用户的回复使用${language}；代码、命令、路径和专有名词保留必要的原文。`,
    // 界面把这行注释当作这一步脚本卡的标题；模型不一定在脚本前写说明文字。
    `每段执行代码的第一行写一句注释（Shell 用 #，Node 用 //），用${language}说明这一步要做什么，不超过 30 个字。`,
    ...(options.executionModes.includes('goal')
      ? [
          '当前启用目标模式：持续推进活动目标并核验结果；达成时用 done("完成依据") 收尾，受阻时按需查询目标能力，记录阻碍和实际依据。',
        ]
      : []),
    ...(options.executionModes.includes('plan')
      ? [
          '当前启用计划模式：先列出可验证的步骤，再按计划继续执行，随进展更新步骤状态。',
          '步骤清单保存在工作区的计划文件，记下验收条件、当前进展和阻碍。',
        ]
      : []),
    ...projectRulesSection(options.projectRules ?? []),
  ].join('\n')
}

/** 项目规则段：按文件原文附上，子目录里的规则只管那个目录；放不下的整份略去并点名。 */
function projectRulesSection(rules: readonly ConversationProjectRule[]): string[] {
  const included: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const rule of rules) {
    const content = rule.content.trim()
    if (!content) continue
    if (used + content.length > ProjectRulesMaxChars) {
      omitted.push(rule.relativePath)
      continue
    }
    used += content.length
    included.push(`<project-rules path="${rule.relativePath}">\n${content}\n</project-rules>`)
  }
  if (!included.length && !omitted.length) return []
  return [
    '',
    '项目里的 AI 规则文件如下，按它们行事；子目录里的规则只管那个目录，与用户这一轮的要求冲突时以用户为准。',
    ...included,
    ...(omitted.length ? [`以下规则文件太长没有附上，需要时自己读：${omitted.join('、')}`] : []),
  ]
}

/** 目标卡片的显示合同（与 Desktop 相同），状态只由 Platform 决定。 */
export function goalArtifact(
  sessionId: string,
  goal: Nullable<GoalState>
): Nullable<ActiveContextArtifact> {
  if (!goal) return null
  return {
    id: goal.id,
    kind: 'requirement',
    scope: 'session',
    sessionId,
    status:
      goal.status === 'removed'
        ? 'archived'
        : goal.status === 'active' || goal.status === 'paused'
          ? 'active'
          : 'completed',
    title: '目标',
    content: goal.objective,
    metadata: {
      goal: true,
      goalStatus: goal.status,
      goalRevision: goal.revision,
      reason: goal.reason,
    },
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

/** 运行没给具体失败原因就收尾时，告诉用户发生了什么、接下来会怎样；按这一轮的界面语言给。 */
const TerminalStatusCopy = {
  'zh-CN': {
    failed: '这一轮运行失败了，没有拿到具体原因。',
    context_blocked: '这一轮需要的材料超出了上下文容量；请精简任务，或开一个新会话再试。',
    goal_active: '助手结束了这一轮，但目标还没有记成完成；可以让它继续核实并收尾，或关掉目标模式。',
    evidence_missing: '收尾需要的材料没有完整拿到，这一轮没能完成；可以让助手缩小范围再试。',
    stale: '收尾时依据的内容已经变化，结果没能确认；可以让助手重新检查。',
    pending: '还有脚本没有执行完，这一轮没能收尾。',
  },
  'en-US': {
    failed: 'This run failed without a specific reason.',
    context_blocked:
      'This run needs more material than the context can hold; narrow the task or start a new conversation.',
    goal_active:
      'The assistant ended this run without marking the goal complete; ask it to verify and finish, or turn goal mode off.',
    evidence_missing:
      'The material needed to finish was not fully available; ask the assistant to narrow the scope and retry.',
    stale:
      'What the result relied on changed before it could be confirmed; ask the assistant to check again.',
    pending: 'Some scripts were still running, so this run could not finish.',
  },
} as const satisfies Record<AppLocale, Record<string, string>>

/** 完成检查没通过时的原因码（`reason` 冒号前的部分）对应哪句话。 */
const VerificationCopyKeys: Readonly<Record<string, keyof (typeof TerminalStatusCopy)['zh-CN']>> = {
  GOAL_ACTIVE: 'goal_active',
  GOAL_CHANGED: 'stale',
  CONTEXT_REQUIRED: 'evidence_missing',
  REQUIRED_EVIDENCE_MISSING: 'evidence_missing',
  STALE_VIEW: 'stale',
  PENDING_EXECUTIONS: 'pending',
}

/**
 * 没有具体失败原因的终态文案：最后一次没通过的完成检查认得出原因码时说那个原因，否则按终态说。
 * 原因里跟在码后面的是写给模型的说明，不给用户看。
 */
export function terminalStatusMessage(
  status: 'failed' | 'context_blocked',
  locale: AppLocale = 'zh-CN',
  verificationReason?: string
): string {
  const code = verificationReason?.split(':')[0]?.trim() ?? ''
  return TerminalStatusCopy[locale][VerificationCopyKeys[code] ?? status]
}

/** 模型用量到了每小时上限、运行会自己等着接着跑时的提示。 */
export function throttledMessage(retryAfterMs: number, locale: AppLocale = 'zh-CN'): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000))
  return locale === 'en-US'
    ? `The hourly model usage limit is reached; this run continues automatically in about ${minutes} min.`
    : `已到每小时的模型用量上限，约 ${minutes} 分钟后自动继续。`
}

/** 连续几步没有进展、运行暂停等下一条消息时的提示；任务保留，回一句话就换个办法接着做。 */
export function stalledMessage(repeatedSteps: number, locale: AppLocale = 'zh-CN'): string {
  return locale === 'en-US'
    ? `No progress for ${repeatedSteps} steps, so this run paused. Reply with anything and it will try another way.`
    : `连续 ${repeatedSteps} 步没有进展，已暂停；回复任意内容，它会换个办法继续。`
}
