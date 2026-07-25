import { isEmpty } from '@velaros/core'
import type { AppLocale, WorkbenchDirectoryEntry, WorkbenchRunCommandResult } from '@velaros/core/types'

import type { WorkbenchRunConfiguration } from '../commands/workbenchRunConfigurations'
import type { WorkbenchEditorOutlineItem, WorkbenchEditorProblemItem } from '../editor/workbenchEditorModel'
import type { WorkbenchProjectContextIndex } from '../project/workbenchProjectContextIndex'

export type WorkbenchActionPromptId =
  | 'fix-problems'
  | 'implementation-pass'
  | 'project-review'
  | 'selected-file'
  | 'verification'

export interface WorkbenchActionPrompt {
  id: WorkbenchActionPromptId
  prompt: string
  command?: string
  disabled: boolean
}

export interface WorkbenchActionProblemReference {
  path?: LooseOptional<string>
  kind: string
  severity?: LooseOptional<string>
  line: number
  column: number
  excerpt: string
}

export interface BuildWorkbenchActionPromptsInput {
  locale: AppLocale
  projectName: string
  projectRoot: string
  selectedEntry: Nullable<WorkbenchDirectoryEntry>
  selectedFilePath: Nullable<string>
  selectedFileContent: string
  selectedFileLanguage: string
  openFiles: Array<{ path: string; language: string; isDirty: boolean }>
  selectedFileOutline: WorkbenchEditorOutlineItem[]
  selectedFileProblems: WorkbenchEditorProblemItem[]
  problemLocations?: WorkbenchActionProblemReference[]
  hasUnsavedChanges: boolean
  projectContextIndex: WorkbenchProjectContextIndex
  commandInput: string
  commandResult: Nullable<WorkbenchRunCommandResult>
  suggestedCommand?: LooseOptional<string>
  runConfigurations?: WorkbenchRunConfiguration[]
  isValidationStale: boolean
}

const FILE_EXCERPT_LIMIT = 3600
const VALIDATION_EXCERPT_LIMIT = 1200
const SAMPLE_LIMIT = 8

interface ContextSummaryOptions {
  validationCommandOverride?: string
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value

  return `${value.slice(0, limit)}\n...`
}

function formatTarget(input: BuildWorkbenchActionPromptsInput): string {
  if (input.selectedFilePath) return input.locale === 'zh-CN'
      ? `当前文件：${input.selectedFilePath}`
      : `Current file: ${input.selectedFilePath}`

  if (input.selectedEntry) return input.locale === 'zh-CN'
      ? `当前条目：${input.selectedEntry.path}（${input.selectedEntry.type}）`
      : `Current entry: ${input.selectedEntry.path} (${input.selectedEntry.type})`

  return input.locale === 'zh-CN' ? '当前目标：整个工程' : 'Current target: whole project'
}

function formatContextSummary(
  input: BuildWorkbenchActionPromptsInput,
  options: ContextSummaryOptions = {}
): string[] {
  const sampleFiles = input.projectContextIndex.files
    .slice(0, SAMPLE_LIMIT)
    .map((file) => file.path)
  const sampleSymbols = input.projectContextIndex.symbols
    .slice(0, SAMPLE_LIMIT)
    .map((symbol) => symbol.label)
  const validationCommand = options.validationCommandOverride ?? getValidationCommand(input)
  const validationStatus = input.commandResult
    ? input.commandResult.success
      ? input.locale === 'zh-CN'
        ? '最近验证：通过'
        : 'Latest check: passed'
      : input.locale === 'zh-CN'
        ? '最近验证：失败'
        : 'Latest check: failed'
    : input.locale === 'zh-CN'
      ? '最近验证：未运行'
      : 'Latest check: not run'
  const openFileLines = input.openFiles
    .slice(0, SAMPLE_LIMIT)
    .map((file) =>
      input.locale === 'zh-CN'
        ? `${file.path}${file.isDirty ? '（未保存）' : ''}`
        : `${file.path}${file.isDirty ? ' (unsaved)' : ''}`
    )
  const runConfigLines = (input.runConfigurations ?? [])
    .slice(0, SAMPLE_LIMIT)
    .map((configuration) => `${configuration.label}: ${configuration.command}`)
  const problemLines = input.selectedFileProblems
    .slice(0, SAMPLE_LIMIT)
    .map((problem) =>
      input.locale === 'zh-CN'
        ? `L${problem.line}:${problem.column} ${problem.kind} - ${problem.excerpt}`
        : `L${problem.line}:${problem.column} ${problem.kind} - ${problem.excerpt}`
    )
  const problemLocationLines = (input.problemLocations ?? [])
    .slice(0, SAMPLE_LIMIT)
    .map((problem) => {
      const location = problem.path
        ? `${problem.path}:${problem.line}:${problem.column}`
        : `L${problem.line}:${problem.column}`
      const severity = problem.severity ? `${problem.severity} ` : ''
      return `${location} ${severity}${problem.kind} - ${problem.excerpt}`
    })
  const outlineLines = input.selectedFileOutline
    .slice(0, SAMPLE_LIMIT)
    .map((item) => `${item.kind} ${item.label} @ L${item.line}`)
  const validationDetail = formatValidationDetail(input)

  if (input.locale === 'zh-CN') return [
      `工程：${input.projectName}`,
      `根目录：${input.projectRoot}`,
      formatTarget(input),
      `上下文：已索引 ${input.projectContextIndex.indexedFileCount} 个文件，抽取 ${input.projectContextIndex.symbols.length} 个符号，已加载 ${input.projectContextIndex.loadedDirectoryCount} 个目录。`,
      !isEmpty(sampleFiles) ? `代表文件：${sampleFiles.join('、')}` : null,
      !isEmpty(sampleSymbols) ? `代表符号：${sampleSymbols.join('、')}` : null,
      !isEmpty(openFileLines) ? `已打开文件：${openFileLines.join('、')}` : null,
      !isEmpty(outlineLines) ? `当前文件大纲：${outlineLines.join('、')}` : null,
      !isEmpty(problemLines) ? `当前文件 Problems：${problemLines.join('；')}` : null,
      !isEmpty(problemLocationLines) ? `工程 Problems：${problemLocationLines.join('；')}` : null,
      !isEmpty(runConfigLines) ? `可用运行配置：${runConfigLines.join('；')}` : null,
      validationCommand
        ? `建议验证命令：${validationCommand}`
        : '建议验证命令：请先识别项目验证入口',
      input.isValidationStale
        ? `${validationStatus}，但文件或目录已变化，结果可能过期。`
        : validationStatus,
      validationDetail,
    ].filter((line): line is string => !!line)

  return [
    `Project: ${input.projectName}`,
    `Root: ${input.projectRoot}`,
    formatTarget(input),
    `Context: indexed ${input.projectContextIndex.indexedFileCount} files, extracted ${input.projectContextIndex.symbols.length} symbols, loaded ${input.projectContextIndex.loadedDirectoryCount} directories.`,
    !isEmpty(sampleFiles) ? `Representative files: ${sampleFiles.join(', ')}` : null,
    !isEmpty(sampleSymbols) ? `Representative symbols: ${sampleSymbols.join(', ')}` : null,
    !isEmpty(openFileLines) ? `Open files: ${openFileLines.join(', ')}` : null,
    !isEmpty(outlineLines) ? `Current file outline: ${outlineLines.join(', ')}` : null,
    !isEmpty(problemLines) ? `Current file Problems: ${problemLines.join('; ')}` : null,
    !isEmpty(problemLocationLines) ? `Project Problems: ${problemLocationLines.join('; ')}` : null,
    !isEmpty(runConfigLines) ? `Run configurations: ${runConfigLines.join('; ')}` : null,
    validationCommand
      ? `Suggested check command: ${validationCommand}`
      : 'Suggested check command: identify the project check entry first',
    input.isValidationStale
      ? `${validationStatus}, but files or directories changed since then.`
      : validationStatus,
    validationDetail,
  ].filter((line): line is string => !!line)
}

function getValidationCommand(input: BuildWorkbenchActionPromptsInput): string {
  return (
    input.suggestedCommand?.trim() ||
    input.runConfigurations?.[0]?.command.trim() ||
    input.commandInput.trim() ||
    input.commandResult?.command.trim() ||
    ''
  )
}

function formatValidationDetail(input: BuildWorkbenchActionPromptsInput): Nullable<string> {
  const result = input.commandResult
  if (!result) return null

  const output = [result.stdout, result.stderr].filter((value) => !!value).join('\n').trim()
  if (!output) return null

  const excerpt = truncateText(output, VALIDATION_EXCERPT_LIMIT)
  return input.locale === 'zh-CN'
    ? `最近验证输出片段（${result.command}）：\n${excerpt}`
    : `Latest check output excerpt (${result.command}):\n${excerpt}`
}

function buildCommonHeader(
  input: BuildWorkbenchActionPromptsInput,
  options?: ContextSummaryOptions
): string {
  return formatContextSummary(input, options).join('\n')
}

function buildProjectReviewPrompt(input: BuildWorkbenchActionPromptsInput): string {
  const header = buildCommonHeader(input)

  if (input.locale === 'zh-CN') return `${header}

请先做一次工程级巡检，不要只凭文件名猜测。优先阅读关键入口、配置、测试和当前目标相关文件，然后用中文输出：
1. 当前工程结构和主要模块职责。
2. 已发现的风险、阻塞点和需要确认的假设。
3. 下一轮最小可交付闭环，包含要改的文件和验证命令。`

  return `${header}

Run a project-level pass. Do not infer from file names alone; inspect the relevant entry points, config, tests, and target files first. Respond with:
1. The current project structure and major module responsibilities.
2. Risks, blockers, and assumptions to verify.
3. The next smallest shippable loop, including files to edit and the check command.`
}

function buildSelectedFilePrompt(input: BuildWorkbenchActionPromptsInput): string {
  const header = buildCommonHeader(input)
  const excerpt = truncateText(input.selectedFileContent, FILE_EXCERPT_LIMIT)
  const language = input.selectedFileLanguage || 'text'

  if (input.locale === 'zh-CN') return `${header}
${input.hasUnsavedChanges ? '\n注意：当前编辑器存在未保存改动，下面内容来自编辑器草稿。\n' : ''}
当前文件内容片段：
\`\`\`${language.toLowerCase()}
${excerpt}
\`\`\`

请围绕当前文件做一次聚焦处理：先解释它在工程中的职责，再指出可以安全改进的地方，最后实现一个小闭环并说明需要运行的验证命令。`

  return `${header}
${input.hasUnsavedChanges ? '\nNote: the editor has unsaved changes; the excerpt below comes from the editor draft.\n' : ''}
Current file excerpt:
\`\`\`${language.toLowerCase()}
${excerpt}
\`\`\`

Focus on this file: explain its role in the project, identify safe improvements, then implement one small loop and state the check command to run.`
}

function buildImplementationPrompt(input: BuildWorkbenchActionPromptsInput): string {
  const header = buildCommonHeader(input)

  if (input.locale === 'zh-CN') return `${header}

请继续推进当前工程工作台任务，保持小闭环但每轮尽量多完成一些：
1. 先确认最直接的下一步，不要偏离当前目标。
2. 优先利用已打开文件、当前大纲、Problems 和运行配置。
3. 复用现有结构和测试习惯。
4. 完成代码修改后运行合适验证。
5. 如果验证失败，基于失败输出修复并重跑。`

  return `${header}

Continue the current engineering task. Keep the loop small but make meaningful progress:
1. Confirm the most direct next step without drifting from the current goal.
2. Use the open files, current outline, Problems, and run configurations.
3. Reuse existing structure and test patterns.
4. Run the appropriate verification after editing.
5. If verification fails, fix from the output and rerun.`
}

function buildFixProblemsPrompt(input: BuildWorkbenchActionPromptsInput): string {
  const header = buildCommonHeader(input)
  const command = getValidationCommand(input)

  if (input.locale === 'zh-CN') return `${header}

请优先修复 Problems 中列出的具体问题，包括编辑器轻量问题和验证输出定位到的文件行。要求：
1. 先定位每个 Problem 是否真实需要修改，避免机械清理造成行为变化。
2. 做最小代码修改；如果需要跨文件调整，先检查相关调用。
3. ${command ? `修改后优先运行：\`${command}\`。` : '修改后识别并运行最合适的验证命令。'}
4. 如果验证失败，继续基于失败输出修复并重跑。`

  return `${header}

Prioritize the listed Problems, including lightweight editor issues and file/line diagnostics from the latest check:
1. Check whether each Problem really needs a code change; avoid mechanical cleanup that changes behavior.
2. Make the smallest code change; inspect related callers before cross-file edits.
3. ${command ? `After editing, prefer: \`${command}\`.` : 'After editing, identify and run the best verification command.'}
4. If verification fails, fix from the output and rerun.`
}

function buildVerificationPrompt(input: BuildWorkbenchActionPromptsInput): string {
  const header = buildCommonHeader(input)
  const command = getValidationCommand(input)

  if (input.locale === 'zh-CN') return `${header}

请执行一次验证闭环。${command ? `优先运行：\`${command}\`。` : '先识别本工程最合适的验证命令。'}如果失败，请根据错误定位原因，做最小修复，然后重新运行验证。最后用中文说明验证结果和剩余风险。`

  return `${header}

Run one verification loop. ${command ? `Prefer: \`${command}\`.` : 'First identify the best check command for this project.'} If it fails, diagnose from the output, make the smallest fix, and rerun verification. Summarize the result and remaining risk.`
}

export function buildWorkbenchActionPrompts(
  input: BuildWorkbenchActionPromptsInput
): WorkbenchActionPrompt[] {
  const validationCommand = getValidationCommand(input)
  const hasFixableProblems =
    !isEmpty(input.selectedFileProblems) ||
    (!!input.problemLocations && !isEmpty(input.problemLocations))

  return [
    {
      id: 'fix-problems',
      prompt: hasFixableProblems ? buildFixProblemsPrompt(input) : '',
      command: validationCommand || undefined,
      disabled: !hasFixableProblems,
    },
    {
      id: 'implementation-pass',
      prompt: buildImplementationPrompt(input),
      command: validationCommand || undefined,
      disabled: false,
    },
    {
      id: 'project-review',
      prompt: buildProjectReviewPrompt(input),
      command: validationCommand || undefined,
      disabled: false,
    },
    {
      id: 'selected-file',
      prompt: input.selectedFilePath ? buildSelectedFilePrompt(input) : '',
      command: validationCommand || undefined,
      disabled: !input.selectedFilePath,
    },
    {
      id: 'verification',
      prompt: buildVerificationPrompt(input),
      command: validationCommand || undefined,
      disabled: false,
    },
  ]
}
