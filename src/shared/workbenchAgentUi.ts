/**
 * Agent 在 Workbench 界面上做的事：打开文件并定位、在文件树里定位、打开改动对比、给代码加讲解气泡、
 * 读取用户此刻在看什么。
 *
 * 工具跑在主进程，界面状态在 renderer：请求经这一轮执行自己的事件流（agent 通道的 notice 事件）只送到
 * 发起这一轮的窗口，renderer 在界面上做完后经 Kernel IPC 回执，工具拿到回执才返回。
 */

/** 装着 {@link WorkbenchAgentUiRequest} 的 notice 事件种类。 */
export const WorkbenchAgentUiNoticeKind = 'workbench.ui-request'

/** 一条讲解气泡：钉在 `path` 的 `startLine..endLine`（从 1 开始，含两端）。 */
export interface WorkbenchAgentUiExplanation {
  /** 相对项目根的路径（主进程已校验存在）。 */
  path: string
  startLine: number
  endLine: number
  /** 气泡标题；没有时为空串。 */
  title: string
  text: string
}

/** 一段 AI 选区：`startLine..endLine`（从 1 开始，含两端）。 */
export interface WorkbenchAgentUiLineRange {
  startLine: number
  endLine: number
}

/** 批量打开里的一个文件。 */
export interface WorkbenchAgentUiOpenFile {
  /** 相对项目根的路径（主进程已校验存在）。 */
  path: string
  line: number
  column: number
  /**
   * AI 选区：这些行标成淡紫色，锁在文件上——切换文件也还在，用户关掉这个文件才释放，
   * AI 可以用 `clear-highlights` 取消。
   */
  highlights: WorkbenchAgentUiLineRange[]
}

export type WorkbenchAgentUiCommand =
  /** 打开一批文件；编辑器最后停在第一个文件的 `line`。 */
  | { type: 'open-files'; files: WorkbenchAgentUiOpenFile[] }
  /** 取消 AI 选区；`paths` 为 null 时取消全部。 */
  | { type: 'clear-highlights'; paths: string[] | null }
  | { type: 'reveal-path'; path: string }
  | { type: 'open-diff'; path: string }
  | {
      type: 'explain-code'
      explanations: WorkbenchAgentUiExplanation[]
      /** true：先清掉这个会话之前加的讲解。 */
      replace: boolean
    }
  | { type: 'clear-explanations'; path: string | null }
  | { type: 'read-editor-state' }
  /** 在底部「运行」面板里启动一条命令（主进程已按命令策略校验、审批过）。 */
  | { type: 'start-run'; command: string; label: string }
  /** 读一条运行的最近输出；`sessionId` 为 null 时读最近启动的那条。 */
  | { type: 'read-run'; sessionId: string | null; lines: number; match: string | null }
  | { type: 'stop-run'; sessionId: string }
  /** 在内置浏览器里打开本机开发服务器的地址；内置浏览器没开时交给系统浏览器。 */
  | { type: 'open-preview'; url: string }
  /** 语言服务诊断；`paths` 为 null 时读编辑器里打开着的文件。 */
  | { type: 'read-problems'; paths: string[] | null; show: boolean }

export interface WorkbenchAgentUiRequest {
  requestId: string
  executionId: string
  sessionId: string
  command: WorkbenchAgentUiCommand
}

export type WorkbenchAgentUiResponse =
  | { requestId: string; executionId: string; ok: true; data: Record<string, unknown> }
  | { requestId: string; executionId: string; ok: false; message: string }

/** `open-files` 的回执数据。 */
export interface WorkbenchAgentOpenFilesResult {
  /** 开出了标签的文件，按请求顺序。 */
  opened: string[]
  /** 编辑器读不出来、没能开出标签的文件（它们的 AI 选区也没标上）。 */
  failed: string[]
}

/** `read-run` 的回执数据。 */
export interface WorkbenchAgentRunSnapshot {
  sessionId: string
  command: string
  running: boolean
  /** 最近若干行输出，已去掉终端控制序列。 */
  output: string
  /** 面板里保留着的输出总行数（面板只留最近一段）。 */
  totalLines: number
  /** 给了 `match` 时：面板保留的输出里是否出现过这段文字（不分大小写）。 */
  matched?: boolean
}

/** `read-problems` 里的一个文件。 */
export interface WorkbenchAgentFileProblems {
  path: string
  problems: Array<{
    severity: 'error' | 'warning' | 'info'
    line: number
    column: number
    message: string
    code?: number | string
  }>
  /** 问题太多只回前面这些时为 true。 */
  truncated: boolean
}

/** `read-editor-state` 的回执数据。 */
export interface WorkbenchAgentEditorState {
  /** 编辑区此刻显示的是什么：普通文件、Git 对比、AI 改动对比，或别的视图。 */
  view: 'file' | 'git-diff' | 'ai-changes' | 'other' | 'empty'
  activeFile: {
    path: string
    line: number
    column: number
    unsaved: boolean
  } | null
  selection: {
    startLine: number
    endLine: number
    text: string
    truncated: boolean
  } | null
  openFiles: Array<{ path: string; unsaved: boolean }>
  explanationCount: number
  /** 还标着的 AI 选区（按文件，行号随用户编辑实时更新）。 */
  aiHighlights: Array<{ path: string; ranges: WorkbenchAgentUiLineRange[] }>
}
