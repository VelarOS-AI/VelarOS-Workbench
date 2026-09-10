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

export type WorkbenchAgentUiCommand =
  | {
      type: 'open-file'
      path: string
      line: number
      column: number
      /** 给出时选中 `line..endLine` 这几行。 */
      endLine: number | null
    }
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

export interface WorkbenchAgentUiRequest {
  requestId: string
  executionId: string
  sessionId: string
  command: WorkbenchAgentUiCommand
}

export type WorkbenchAgentUiResponse =
  | { requestId: string; executionId: string; ok: true; data: Record<string, unknown> }
  | { requestId: string; executionId: string; ok: false; message: string }

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
}
