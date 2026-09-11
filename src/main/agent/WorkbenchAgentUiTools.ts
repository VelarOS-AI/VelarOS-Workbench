import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import type { ToolCategoryDefinition, ToolCategoryId } from '@velaros-ai/agent/protocol'
import {
  type ApprovalPort,
  createApprovalOperationKey,
  defineToolRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'
import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchAgentUiCommand,
  WorkbenchAgentUiExplanation,
  WorkbenchAgentUiOpenFile,
} from '../../shared/workbenchAgentUi'
import { analyzeWorkbenchCommandExecution } from '../workspace/CommandExecutionPolicy'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from '../workspace/PathContainmentHelper'

import type { WorkbenchAgentUiPort } from './WorkbenchAgentUiBridge'

/** 界面类别只给主 Agent：子 Agent 的类型表不含它，也没有可回执的窗口。 */
const WorkbenchAgentUiCategoryId: ToolCategoryId = 'workbench-ui'

const WorkbenchAgentUiCategory: Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> =
  Object.freeze({
    [WorkbenchAgentUiCategoryId]: Object.freeze({
      id: WorkbenchAgentUiCategoryId,
      label: '工作台界面',
      description:
        '在用户眼前的 Workbench 里批量打开文件、用淡紫色 AI 选区标出代码、在文件树里定位、打开改动对比、给代码加讲解气泡，' +
        '在「运行」面板里跑长驻命令并读输出、打开本机预览、读问题列表，以及读取用户此刻在编辑器里看的内容。',
      toolOs: Object.freeze({ domain: 'workbench', defaultState: 'resident' }),
    }),
  })

/** 数行号时最多读这么大的文件；更大的文件不钳行号，交给编辑器自己夹住。 */
const LineCountReadLimitBytes = 16 * 1024 * 1024
const MaxExplanationsPerCall = 30
const DefaultRunOutputLines = 60
const MaxRunOutputLines = 300
/** 等运行输出里出现某段文字最多等这么久；再久让模型自己分次读。 */
const MaxRunWaitSeconds = 60
const DefaultRunWaitSeconds = 20
const RunPollIntervalMs = 1000
const MaxProblemFiles = 20

/** 工具要用到的那部分 Workbench 工具上下文。 */
interface WorkbenchAgentUiToolContext {
  resourceId: string
  abortSignal: AbortSignal
  /** 这一轮的审批通道；「运行」面板里跑可能改动项目的命令前先问。 */
  approval: ApprovalPort
  workbenchUi?: WorkbenchAgentUiPort
}

function readUiToolContext(value: unknown): WorkbenchAgentUiToolContext {
  return value as WorkbenchAgentUiToolContext
}

function hasWorkbenchUi(value: unknown): boolean {
  return !!readUiToolContext(value).workbenchUi
}

function requireWorkbenchUi(context: WorkbenchAgentUiToolContext): WorkbenchAgentUiPort {
  if (!context.workbenchUi)
    throw new AppError('UNAVAILABLE', 'No Workbench window is attached to this run.')
  return context.workbenchUi
}

interface ProjectEntry {
  /** 项目根相对、`/` 分隔。 */
  path: string
  absolutePath: string
  isDirectory: boolean
}

/** 把模型给的路径落到项目里的一个真实条目上；越界或不存在直接报错，别让界面去猜。 */
async function resolveProjectEntry(projectRoot: string, rawPath: string): Promise<ProjectEntry> {
  const input = rawPath.trim()
  if (!input || input.includes('\0'))
    throw new AppError('VALIDATION', 'path must be a file or folder inside the project.')
  const root = resolve(projectRoot)
  const absolutePath = isAbsolute(input) ? resolve(input) : resolve(root, input)
  const relativePath = getRelativePathInsideRoot(root, absolutePath)
  if (!isPresent(relativePath))
    throw new AppError('PERMISSION', `${input} is outside the project root.`)
  let isDirectory: boolean
  try {
    isDirectory = (await stat(absolutePath)).isDirectory()
  } catch {
    throw new AppError('NOT_FOUND', `${input} does not exist in the project.`)
  }
  return {
    path: relativePath === '.' ? '.' : toPortableRelativePath(relativePath),
    absolutePath,
    isDirectory,
  }
}

/** 只校验落在项目里（不要求存在）：清掉标记这类操作针对的文件可能已经被删了。 */
function resolveProjectRelativePath(projectRoot: string, rawPath: string): string {
  const root = resolve(projectRoot)
  const input = rawPath.trim()
  const relativePath = getRelativePathInsideRoot(
    root,
    isAbsolute(input) ? resolve(input) : resolve(root, input)
  )
  if (!isPresent(relativePath) || relativePath === '.')
    throw new AppError('PERMISSION', `${input} is not a file inside the project.`)
  return toPortableRelativePath(relativePath)
}

async function resolveProjectFile(projectRoot: string, rawPath: string): Promise<ProjectEntry> {
  const entry = await resolveProjectEntry(projectRoot, rawPath)
  if (entry.isDirectory) throw new AppError('VALIDATION', `${rawPath.trim()} is a folder, not a file.`)
  return entry
}

interface FileLineInfo {
  /** 与编辑器同一种数法：`\n` 的个数 + 1（结尾换行后面那一行也算）。 */
  lineCount: number
  /** 最后一个有内容的行：文件以换行结尾时，结尾换行后面那个空行不算。 */
  lastContentLine: number
}

/** 读不了或太大时为 null（不钳行号，交给编辑器自己夹住）。 */
async function readFileLineInfo(absolutePath: string): Promise<FileLineInfo | null> {
  try {
    if ((await stat(absolutePath)).size > LineCountReadLimitBytes) return null
    const content = await readFile(absolutePath, 'utf8')
    let lineCount = 1
    for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1))
      lineCount += 1
    return {
      lineCount,
      lastContentLine: content.endsWith('\n') ? Math.max(1, lineCount - 1) : lineCount,
    }
  } catch {
    return null
  }
}

/** 起始行越界是模型记错了文件，直接报出来；结束行只夹住，不为一两行的出入打回。 */
function resolveLineRange(
  path: string,
  lineCount: number | null,
  startLine: number,
  endLine: number | undefined
): { startLine: number; endLine: number } {
  if (isPresent(lineCount) && startLine > lineCount)
    throw new AppError('VALIDATION', `${path} has only ${lineCount} lines; line ${startLine} does not exist.`)
  const requestedEnd = Math.max(startLine, endLine ?? startLine)
  return {
    startLine,
    endLine: isPresent(lineCount) ? Math.min(requestedEnd, lineCount) : requestedEnd,
  }
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`
}

async function sendCommand(
  context: WorkbenchAgentUiToolContext,
  command: WorkbenchAgentUiCommand
): Promise<Readonly<Record<string, unknown>>> {
  context.abortSignal.throwIfAborted()
  return requireWorkbenchUi(context).request(command)
}

/** 等一会儿再读；这一轮被停下时立刻结束等待。 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new AppError('ABORTED', 'This run was stopped.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 读一条运行的输出；给了 `waitFor` 就轮询到这段文字出现（例如开发服务器打出 `Local:`），进程退出或
 * 等满 `waitSeconds` 为止。只给 `waitSeconds` 时等满再读。
 */
async function readRunOutput(
  context: WorkbenchAgentUiToolContext,
  input: { sessionId: string | null; lines?: number; waitFor?: string; waitSeconds?: number }
): Promise<Readonly<Record<string, unknown>>> {
  const lines = Math.min(input.lines ?? DefaultRunOutputLines, MaxRunOutputLines)
  const match = input.waitFor?.trim() || null
  const waitSeconds = Math.min(
    input.waitSeconds ?? (match ? DefaultRunWaitSeconds : 0),
    MaxRunWaitSeconds
  )
  const deadline = Date.now() + waitSeconds * 1000
  let sessionId = input.sessionId
  for (;;) {
    const snapshot = await sendCommand(context, { type: 'read-run', sessionId, lines, match })
    // 第一次读到的是哪条运行，之后就一直盯着它，别在等待期间换到别人新开的那条。
    if (typeof snapshot.sessionId === 'string') sessionId = snapshot.sessionId
    if ((match && snapshot.matched === true) || snapshot.running !== true || Date.now() >= deadline)
      return snapshot
    await sleepUnlessAborted(RunPollIntervalMs, context.abortSignal)
  }
}

/** 预览只开本机开发服务器：localhost、回环、局域网私有地址与 `.local`。 */
function isLocalPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '0.0.0.0') return true
  const octets = host.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [first, second] = octets as [number, number, number, number]
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  )
}

const PathSchema = z.string().min(1).describe('Project-relative path (an absolute path inside the project also works).')
const LineSchema = z.number().int().min(1)
const MaxFilesPerOpen = 12
const MaxHighlightsPerFile = 20

const HighlightSchema = z.object({
  startLine: LineSchema,
  endLine: LineSchema.optional().describe('Last highlighted line (inclusive); defaults to startLine.'),
})

const OpenFileItemSchema = z.object({
  path: PathSchema,
  line: LineSchema.optional().describe('Line to jump to, 1-based; defaults to the first highlight or line 1.'),
  column: LineSchema.optional().describe('Column on that line, 1-based.'),
  endLine: LineSchema.optional().describe('Shorthand for one highlight from line to endLine.'),
  highlights: z.array(HighlightSchema).optional()
    .describe(`Line ranges to mark as AI selections (light purple) in this file; up to ${MaxHighlightsPerFile} per file.`),
})

type OpenFileItemInput = z.infer<typeof OpenFileItemSchema>
type OpenFileInput = Partial<OpenFileItemInput> & { files?: OpenFileItemInput[] }

/**
 * 单个文件的写法（顶层 path）与批量写法（files）都收；两者都给时顶层那一项当第一个文件（files 里
 * 有同一个文件就并进去），并在回执里说明。两者都没有才打回。
 */
function readOpenFileItems(input: OpenFileInput, notes: string[]): OpenFileItemInput[] {
  const items = [...(input.files ?? [])]
  if (input.path) {
    if (items.length > 0) notes.push(`Both path and files were given; ${input.path} was opened as the first file.`)
    items.unshift({
      path: input.path,
      ...(isPresent(input.line) ? { line: input.line } : {}),
      ...(isPresent(input.column) ? { column: input.column } : {}),
      ...(isPresent(input.endLine) ? { endLine: input.endLine } : {}),
      ...(input.highlights ? { highlights: input.highlights } : {}),
    })
  }
  if (items.length === 0) throw new AppError('VALIDATION', 'Pass files: [{ path, ... }] (or a single path).')
  return items
}

/** 一个要打开的文件，同一文件出现多次时合并在这里。 */
interface OpenFilePlan {
  path: string
  /** 模型明确给的跳转位置；没给时跳到第一段选区。 */
  line: number | null
  column: number | null
  highlights: Array<{ startLine: number; endLine: number }>
}

/**
 * 一段选区落到文件的真实行上：起始行越界的这一段丢掉（在回执里说），结束行夹到最后一个有内容的行
 * （结尾换行后面那个空行不标）。
 */
function clampHighlight(
  path: string,
  info: FileLineInfo | null,
  range: { startLine: number; endLine?: number },
  notes: string[]
): { startLine: number; endLine: number } | null {
  if (info && range.startLine > info.lineCount) {
    notes.push(`${path} has only ${info.lineCount} lines; the selection starting at line ${range.startLine} was skipped.`)
    return null
  }
  const requestedEnd = Math.max(range.startLine, range.endLine ?? range.startLine)
  return {
    startLine: range.startLine,
    endLine: info ? Math.min(requestedEnd, Math.max(range.startLine, info.lastContentLine)) : requestedEnd,
  }
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

const openFileTool = defineToolRuntimeSpec<OpenFileInput, WorkbenchAgentUiToolContext>({
  name: 'workbench:open_file',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary:
    '在用户眼前的编辑器里打开项目文件（一次可以打开多个），定位到某一行，并把要用户看的代码标成 AI 选区（淡紫色）。',
  suitable: [
    '用户想看某个文件或某段代码：让它直接出现在编辑器里，而不是只在回答里贴路径。',
    '讲解、排查或改完代码后，把用户带到相关的位置；涉及几个文件时一次打开。',
  ],
  forbidden: [
    '不要用它读文件内容；读内容用 project:read。',
    '不要打开与用户此刻要看的内容无关的文件。',
  ],
  usage: [
    `files 批量打开（最多 ${MaxFilesPerOpen} 个），编辑器最后停在第一个文件；只开一个文件时也可以直接传 path。`,
    'line / column 从 1 开始；highlights（或 endLine 简写）把这些行标成 AI 选区：淡紫色、锁在文件上，切换文件也还在，用户关掉这个文件才消失。',
    '要取消 AI 选区用 workbench:clear_highlights；再次打开同一个文件时新加的选区与原有的并存。',
  ],
  examples: [
    { path: 'src/main.ts' },
    {
      files: [
        { path: 'src/server/router.ts', highlights: [{ startLine: 42, endLine: 58 }] },
        { path: 'src/server/auth.ts', line: 10, highlights: [{ startLine: 10, endLine: 24 }, { startLine: 80 }] },
      ],
    },
  ],
  notes: [
    '返回每个文件实际定位到的行和标上的选区（越界的结束行会被夹到文件末尾）。',
    '打不开的文件、起始行越界的选区会被跳过，不连累同一批里的其他文件；跳过了什么写在 failed / notes 里。',
  ],
  schema: OpenFileItemSchema.partial().extend({
    files: z.array(OpenFileItemSchema).optional()
      .describe(`Files to open in one call (up to ${MaxFilesPerOpen}); the editor ends on the first one.`),
  }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    const notes: string[] = []
    const failed: Array<{ path: string; reason: string }> = []
    let firstError: AppError | null = null
    const plans: OpenFilePlan[] = []
    const skipped: string[] = []
    for (const item of readOpenFileItems(input, notes)) {
      let file: ProjectEntry
      try {
        file = await resolveProjectFile(context.resourceId, item.path)
      } catch (error) {
        const appError = AppError.from(error)
        firstError ??= appError
        failed.push({ path: item.path, reason: appError.message })
        continue
      }
      let plan = plans.find((candidate) => candidate.path === file.path)
      if (!plan) {
        if (plans.length >= MaxFilesPerOpen) {
          skipped.push(file.path)
          continue
        }
        plan = { path: file.path, line: null, column: null, highlights: [] }
        plans.push(plan)
      }
      const info = await readFileLineInfo(file.absolutePath)
      if (isPresent(item.line) && plan.line === null) {
        plan.line = info ? Math.min(item.line, info.lineCount) : item.line
        plan.column = item.column ?? null
        if (plan.line !== item.line)
          notes.push(`${file.path} has only ${plan.line} lines; jumped to line ${plan.line} instead of ${item.line}.`)
      }
      const requested = [
        ...(isPresent(item.endLine) ? [{ startLine: item.line ?? 1, endLine: item.endLine }] : []),
        ...(item.highlights ?? []),
      ]
      for (const range of requested) {
        const highlight = clampHighlight(file.path, info, range, notes)
        if (!highlight) continue
        if (plan.highlights.length >= MaxHighlightsPerFile) {
          notes.push(`Only the first ${MaxHighlightsPerFile} selections in ${file.path} were kept.`)
          break
        }
        plan.highlights.push(highlight)
      }
    }
    if (skipped.length > 0)
      notes.push(`Only the first ${MaxFilesPerOpen} files were opened; skipped ${skipped.join(', ')}.`)
    if (plans.length === 0) throw firstError ?? new AppError('VALIDATION', 'No file to open.')

    const files: WorkbenchAgentUiOpenFile[] = plans.map((plan) => ({
      path: plan.path,
      line: plan.line ?? plan.highlights[0]?.startLine ?? 1,
      column: plan.column ?? 1,
      highlights: plan.highlights,
    }))
    const result = await sendCommand(context, { type: 'open-files', files })
    const notOpened = new Set(readStringList(result.failed))
    for (const path of notOpened) failed.push({ path, reason: 'The editor could not read this file.' })
    return {
      opened: files
        .filter((file) => !notOpened.has(file.path))
        .map((file) => ({
          path: file.path,
          line: file.line,
          ...(file.highlights.length > 0
            ? { highlights: file.highlights.map((range) => formatRange(file.path, range.startLine, range.endLine)) }
            : {}),
        })),
      ...(failed.length > 0 ? { failed } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    }
  },
})

const clearHighlightsTool = defineToolRuntimeSpec<{ paths?: string[] }, WorkbenchAgentUiToolContext>({
  name: 'workbench:clear_highlights',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '取消编辑器里的 AI 选区（淡紫色标记）：全部取消，或只取消某几个文件上的。',
  suitable: ['指给用户看的代码已经讲完、或要换一批位置标记时，先把旧的选区取消。'],
  forbidden: ['不要取消用户还在对照着看的选区；用户关掉文件时选区会自己消失。'],
  usage: ['不给 paths（或给空数组）取消全部 AI 选区；给 paths 只取消这些文件上的。'],
  examples: [{}, { paths: ['src/cache.ts', 'src/store.ts'] }],
  notes: ['返回取消了几段选区；不在项目里的路径会被忽略并列在 ignored 里。'],
  schema: z.object({ paths: z.array(PathSchema).optional() }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    if (!input.paths || input.paths.length === 0)
      return sendCommand(context, { type: 'clear-highlights', paths: null })
    const paths = new Set<string>()
    const ignored: string[] = []
    for (const path of input.paths) {
      try {
        paths.add(resolveProjectRelativePath(context.resourceId, path))
      } catch {
        ignored.push(path)
      }
    }
    // 给的路径全都不在项目里：一个也不取消，而不是退回「全部取消」。
    const result = paths.size > 0
      ? await sendCommand(context, { type: 'clear-highlights', paths: [...paths] })
      : { cleared: 0 }
    return { ...result, ...(ignored.length > 0 ? { ignored } : {}) }
  },
})

const revealTool = defineToolRuntimeSpec<{ path: string }, WorkbenchAgentUiToolContext>({
  name: 'workbench:reveal_in_explorer',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '在左侧文件树里展开并选中一个文件或目录，让用户看到它在项目里的位置。',
  suitable: ['介绍项目结构、指出新建的文件或目录时，把用户的文件树带到那里。'],
  forbidden: ['不要用它列目录内容；列目录用 project:list。'],
  usage: ['path 可以是文件，也可以是目录。'],
  examples: [{ path: 'src/components' }],
  notes: ['文件树会切到项目视图并展开到这一项。'],
  schema: z.object({ path: PathSchema }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    const entry = await resolveProjectEntry(context.resourceId, input.path)
    if (entry.path === '.')
      throw new AppError('VALIDATION', 'Pass a file or folder inside the project, not the project root.')
    await sendCommand(context, { type: 'reveal-path', path: entry.path })
    return { revealed: true, path: entry.path, kind: entry.isDirectory ? 'directory' : 'file' }
  },
})

const openDiffTool = defineToolRuntimeSpec<{ path: string }, WorkbenchAgentUiToolContext>({
  name: 'workbench:open_diff',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '在编辑器里打开一个文件的 Git 改动对比（工作区里还没提交的改动），新增和删除的行会高亮。',
  suitable: ['要让用户过目某个文件改了什么、提交之前核对改动时。'],
  forbidden: [
    '不要为了「展示这一轮你改了什么」逐个打开文件：一轮结束后 Workbench 会自动打开这一轮的 AI 改动。',
    '文件没有未提交的改动时没有可对比的内容。',
  ],
  usage: ['path 必须是 Git 认为有改动（含未跟踪）的文件。'],
  examples: [{ path: 'src/api/client.ts' }],
  notes: ['对比显示整份文件，改动处高亮，用户可以在改动之间跳转。'],
  schema: z.object({ path: PathSchema }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui', 'git'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    // 删除掉的文件也可能有改动可看，这里只拦越界路径，存不存在交给 Git 状态判断。
    const root = resolve(context.resourceId)
    const rawPath = input.path.trim()
    const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
    const relativePath = getRelativePathInsideRoot(root, absolutePath)
    if (!isPresent(relativePath) || relativePath === '.')
      throw new AppError('PERMISSION', `${rawPath} is not a file inside the project.`)
    const path = toPortableRelativePath(relativePath)
    const data = await sendCommand(context, { type: 'open-diff', path })
    return { opened: true, path, ...data }
  },
})

type ExplainCodeInput = {
  explanations: Array<{
    path: string
    startLine: number
    endLine?: number
    title?: string
    text: string
  }>
  replace?: boolean
}

const explainCodeTool = defineToolRuntimeSpec<ExplainCodeInput, WorkbenchAgentUiToolContext>({
  name: 'workbench:explain_code',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary:
    '在编辑器里给代码加讲解气泡：高亮一段行，并在它下面显示一段说明。一次可以加多条，组成一条讲解路线，用户逐条翻看。',
  suitable: [
    '用户让你讲解、带读、review 代码时，把讲解钉在对应的代码旁边，用户对着代码看。',
    '要指出几处相互关联的代码（调用链、数据流、改动点）时，一处一条气泡，按讲解顺序排列。',
  ],
  forbidden: [
    '不要用它代替回答：结论照样写在回答里，气泡负责把讲解逐处落到代码上。',
    '不要给没读过的代码加讲解；先用 project:read 确认行号。',
  ],
  usage: [
    'explanations 按讲解顺序排列；每条是 path + startLine/endLine（从 1 开始，含两端）+ text，可选 title。',
    'replace 默认 true：先清掉你之前加的讲解，再加这一批；要在已有讲解后面追加时传 false。',
    '单条 text 控制在几句话之内，长篇解释放在回答里。',
  ],
  examples: [
    {
      explanations: [
        {
          path: 'src/cache.ts',
          startLine: 12,
          endLine: 30,
          title: '先查内存',
          text: '按 key 查内存表，命中直接返回；未命中才去读磁盘。',
        },
        { path: 'src/cache.ts', startLine: 44, endLine: 52, text: '读盘结果写回内存表，下次命中。' },
      ],
    },
  ],
  notes: ['编辑器会打开第一条讲解所在的文件并展开它的气泡；用户可以用气泡上的按钮前后翻看。'],
  schema: z.object({
    explanations: z
      .array(
        z.object({
          path: PathSchema,
          startLine: LineSchema,
          endLine: LineSchema.optional(),
          title: z.string().max(120).optional(),
          text: z.string().min(1).max(4000),
        })
      )
      .min(1)
      .max(MaxExplanationsPerCall),
    replace: z.boolean().optional(),
  }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    const lineCounts = new Map<string, number | null>()
    const explanations: WorkbenchAgentUiExplanation[] = []
    for (const item of input.explanations) {
      const file = await resolveProjectFile(context.resourceId, item.path)
      if (!lineCounts.has(file.absolutePath))
        lineCounts.set(file.absolutePath, (await readFileLineInfo(file.absolutePath))?.lineCount ?? null)
      const range = resolveLineRange(
        file.path,
        lineCounts.get(file.absolutePath) ?? null,
        item.startLine,
        item.endLine
      )
      explanations.push({
        path: file.path,
        startLine: range.startLine,
        endLine: range.endLine,
        title: item.title?.trim() ?? '',
        text: item.text.trim(),
      })
    }
    await sendCommand(context, {
      type: 'explain-code',
      explanations,
      replace: input.replace ?? true,
    })
    return {
      added: explanations.length,
      explanations: explanations.map((item) => formatRange(item.path, item.startLine, item.endLine)),
    }
  },
})

const clearExplanationsTool = defineToolRuntimeSpec<{ path?: string }, WorkbenchAgentUiToolContext>({
  name: 'workbench:clear_explanations',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '清掉编辑器里的讲解气泡：全部清掉，或只清某一个文件上的。',
  suitable: ['讲解结束、或用户说「把这些气泡去掉」时。'],
  forbidden: ['换一批讲解时不必先清：workbench:explain_code 默认会替换掉之前的讲解。'],
  usage: ['不给 path 清掉全部讲解；给 path 只清这个文件上的。'],
  examples: [{}, { path: 'src/cache.ts' }],
  notes: ['返回清掉了几条。'],
  schema: z.object({ path: PathSchema.optional() }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    const path = isPresent(input.path) ? resolveProjectRelativePath(context.resourceId, input.path) : null
    return sendCommand(context, { type: 'clear-explanations', path })
  },
})

const editorStateTool = defineToolRuntimeSpec<Record<string, unknown>, WorkbenchAgentUiToolContext>({
  name: 'workbench:get_editor_state',
  category: WorkbenchAgentUiCategoryId,
  role: 'inspect',
  summary: '读取用户此刻在编辑器里看的内容：当前文件和光标位置、选中的代码、打开的标签页、哪些文件还没保存。',
  suitable: ['用户说「这段」「这里」「我选中的」「当前文件」却没贴代码时，先读它再动手。'],
  forbidden: ['不要用它读文件全文；全文用 project:read。'],
  usage: ['没有参数。selection.text 过长时会截断（truncated 为 true），需要全文再用 project:read 按行读。'],
  examples: [{}],
  notes: ['未保存的文件磁盘内容与编辑器里的不一致；改这类文件前先提醒用户保存。'],
  schema: z.object({}),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'safe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => true,
  execute: async (_input, context) => sendCommand(context, { type: 'read-editor-state' }),
})

const RunWaitSchema = {
  waitFor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Wait until this text appears in the output (case-insensitive), e.g. "Local:" or "ready".'),
  waitSeconds: z.number().int().min(0).max(MaxRunWaitSeconds).optional(),
}

const startRunTool = defineToolRuntimeSpec<
  { command: string; label?: string; waitFor?: string; waitSeconds?: number },
  WorkbenchAgentUiToolContext
>({
  name: 'workbench:start_run',
  category: WorkbenchAgentUiCategoryId,
  role: 'execute',
  summary:
    '在底部「运行」面板里启动一条命令，用户能看到实时输出、随时停止；适合开发服务器、监听模式测试这类长驻进程。',
  suitable: [
    '要把项目跑起来（`npm run dev` 这类不会自己结束的命令）给用户看效果时。',
    '用户说「帮我启动」「跑一下测试看看」并希望在运行面板里看到过程时。',
  ],
  forbidden: [
    '跑完就结束、只需要结果的一次性命令用 project:run，不要占运行面板。',
    '不要重复启动同一条长驻命令；先用 workbench:read_run 看它还在不在跑。',
  ],
  usage: [
    '开发服务器传 waitFor（例如 "Local:"、"ready"），会等到这段输出出现再返回，最多等 60 秒。',
    '返回的 sessionId 给 workbench:read_run / workbench:stop_run 用。',
    '可能改动项目的命令会先请用户确认；破坏性命令直接拒绝。',
  ],
  examples: [
    { command: 'npm run dev', label: '开发服务器', waitFor: 'Local:' },
    { command: 'bun test --watch' },
  ],
  notes: ['进程跑在项目根目录，关掉窗口或用户点停止都会结束它。'],
  schema: z.object({
    command: z.string().min(1).max(2000),
    label: z.string().max(80).optional(),
    ...RunWaitSchema,
  }),
  permissions: ['process:exec'],
  capabilities: {
    effectKind: 'execute',
    readScopes: ['workbench-ui'],
    process: { execution: 'long-running' },
    concurrency: 'unsafe',
  },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    const command = input.command.trim()
    const plan = analyzeWorkbenchCommandExecution(command)
    if (plan.isDangerous)
      throw new AppError('PERMISSION', `The command was rejected by the safety policy: ${command}`)
    if (!plan.isReadOnly) {
      const decision = await context.approval.awaitConfirmationDecision(
        `在底部「运行」面板里运行：${command}`,
        context.abortSignal,
        {
          approvalRisk: 'high',
          riskScope: 'workbench-run:command',
          operation: {
            key: createApprovalOperationKey('workbench-run', { command, root: context.resourceId }),
            label: command,
            target: context.resourceId,
          },
        }
      )
      if (!decision.approved)
        return {
          started: false,
          command,
          message: decision.message ?? 'The user declined to run this command.',
        }
    }
    const started = await sendCommand(context, {
      type: 'start-run',
      command,
      label: input.label?.trim() || command,
    })
    const sessionId = typeof started.sessionId === 'string' ? started.sessionId : null
    if (!sessionId) throw new AppError('PLATFORM', 'Workbench could not start the run.')
    if (!input.waitFor && !input.waitSeconds) return { started: true, sessionId, command }
    return {
      started: true,
      ...(await readRunOutput(context, {
        sessionId,
        waitFor: input.waitFor,
        waitSeconds: input.waitSeconds,
      })),
    }
  },
})

const readRunTool = defineToolRuntimeSpec<
  { sessionId?: string; lines?: number; waitFor?: string; waitSeconds?: number },
  WorkbenchAgentUiToolContext
>({
  name: 'workbench:read_run',
  category: WorkbenchAgentUiCategoryId,
  role: 'inspect',
  summary: '读「运行」面板里一条运行的最近输出和是否还在跑，可以等某段输出出现再返回。',
  suitable: [
    '启动开发服务器或测试后，看它有没有起来、有没有报错。',
    '用户说「运行面板里报错了」时，先读输出再判断。',
  ],
  forbidden: ['不要用它读普通文件；读文件用 project:read。'],
  usage: [
    '不给 sessionId 读最近启动的那条运行。',
    'lines 是返回的输出行数（默认 60，最多 300）；面板本身只保留最近一段输出。',
    'waitFor / waitSeconds 同 workbench:start_run。',
  ],
  examples: [{}, { sessionId: 'run-session-id', lines: 120 }, { waitFor: 'compiled', waitSeconds: 30 }],
  notes: ['output 已去掉终端颜色等控制序列；running 为 false 表示进程已经退出。'],
  schema: z.object({
    sessionId: z.string().min(1).optional(),
    lines: z.number().int().min(1).max(MaxRunOutputLines).optional(),
    ...RunWaitSchema,
  }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'safe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => true,
  execute: async (input, context) =>
    readRunOutput(context, {
      sessionId: input.sessionId ?? null,
      lines: input.lines,
      waitFor: input.waitFor,
      waitSeconds: input.waitSeconds,
    }),
})

const stopRunTool = defineToolRuntimeSpec<{ sessionId: string }, WorkbenchAgentUiToolContext>({
  name: 'workbench:stop_run',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '停止「运行」面板里的一条运行（相当于用户点停止）。',
  suitable: ['要重启开发服务器、或用户让你停掉某个进程时。'],
  forbidden: ['不要停掉用户自己启动、且没让你停的运行。'],
  usage: ['sessionId 来自 workbench:start_run 或 workbench:read_run 的返回。'],
  examples: [{ sessionId: 'run-session-id' }],
  notes: ['停止后面板里的输出还在，用户可以接着看。'],
  schema: z.object({ sessionId: z.string().min(1) }),
  permissions: ['process:exec'],
  capabilities: { effectKind: 'execute', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    await sendCommand(context, { type: 'stop-run', sessionId: input.sessionId })
    return { stopped: true, sessionId: input.sessionId }
  },
})

const openPreviewTool = defineToolRuntimeSpec<{ url: string }, WorkbenchAgentUiToolContext>({
  name: 'workbench:open_preview',
  category: WorkbenchAgentUiCategoryId,
  role: 'control',
  summary: '把本机开发服务器的地址打开给用户看：优先在 Workbench 内置浏览器里，没开内置浏览器时用系统浏览器。',
  suitable: ['开发服务器起来之后，让用户直接看到页面效果。'],
  forbidden: [
    '只能打开本机地址（localhost、127.0.0.1、局域网地址）；外部网址写在回答里给用户。',
    '不要用它自己浏览网页；要操作页面用 browser 工具。',
  ],
  usage: ['url 用开发服务器打印出来的地址，例如 http://localhost:5173/。'],
  examples: [{ url: 'http://localhost:5173/' }],
  notes: ['返回 opened: workbench-browser 或 system-browser。'],
  schema: z.object({ url: z.string().min(1).max(2000) }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'unsafe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    let url: URL
    try {
      url = new URL(input.url.trim())
    } catch {
      throw new AppError('VALIDATION', `${input.url} is not a valid address.`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new AppError('VALIDATION', 'Only http(s) addresses can be previewed.')
    if (!isLocalPreviewHost(url.hostname))
      throw new AppError(
        'PERMISSION',
        'Only local development servers can be previewed (localhost, 127.0.0.1, LAN addresses). Put other links in the answer.'
      )
    return { url: url.toString(), ...(await sendCommand(context, { type: 'open-preview', url: url.toString() })) }
  },
})

const getProblemsTool = defineToolRuntimeSpec<
  { paths?: string[]; show?: boolean },
  WorkbenchAgentUiToolContext
>({
  name: 'workbench:get_problems',
  category: WorkbenchAgentUiCategoryId,
  role: 'inspect',
  summary: '读编辑器语言服务报告的问题（类型错误、未使用的变量等），可以同时把「问题」面板打开给用户看。',
  suitable: [
    '改完代码后检查有没有引入类型错误，而不必跑一遍完整的类型检查。',
    '用户说「这里标红了」「有报错」时，先读具体问题。',
  ],
  forbidden: ['它只看语言服务支持的文件（如 TS/JS）；需要完整构建或测试结果时用 project:run。'],
  usage: [
    '给 paths 读这些文件（最多 20 个）；不给读编辑器里打开着的文件。',
    'show 为 true 时把第一个有问题的文件定位到它的第一个问题，并打开底部「问题」面板（面板列的是当前文件的问题）。',
  ],
  examples: [{ paths: ['src/cache.ts'] }, { show: true }],
  notes: ['未保存的文件按编辑器里的内容检查。'],
  schema: z.object({
    paths: z.array(PathSchema).min(1).max(MaxProblemFiles).optional(),
    show: z.boolean().optional(),
  }),
  permissions: [],
  capabilities: { effectKind: 'read', readScopes: ['workbench-ui'], concurrency: 'safe' },
  hideWhenUnavailable: true,
  isAvailable: hasWorkbenchUi,
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    const paths = input.paths
      ? await Promise.all(
          input.paths.map(async (path) => (await resolveProjectFile(context.resourceId, path)).path)
        )
      : null
    return sendCommand(context, {
      type: 'read-problems',
      paths: paths ? [...new Set(paths)] : null,
      show: input.show ?? false,
    })
  },
})

/**
 * 在用户眼前操作 Workbench 的工具。它们只在界面口在场时可见（`hideWhenUnavailable`）：探针、测试
 * 与子 Agent 的上下文里没有发起窗口，工具整格隐身，而不是被调用后才报「没有窗口」。
 */
const WorkbenchAgentUiToolSpecs = Object.freeze([
  openFileTool,
  clearHighlightsTool,
  revealTool,
  openDiffTool,
  explainCodeTool,
  clearExplanationsTool,
  editorStateTool,
  startRunTool,
  readRunTool,
  stopRunTool,
  openPreviewTool,
  getProblemsTool,
])

export { WorkbenchAgentUiCategory, WorkbenchAgentUiCategoryId, WorkbenchAgentUiToolSpecs }
export type { WorkbenchAgentUiToolContext }
