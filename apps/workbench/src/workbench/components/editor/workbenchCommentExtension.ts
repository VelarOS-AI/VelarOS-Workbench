import type { Extension, Range, Transaction } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { isEmpty } from '@velaros-ai/core'

import {
  getWorkbenchComment,
  type WorkbenchComment,
} from '../../models/comments/workbenchCommentStore'

/**
 * 工作台行内评论装饰扩展。
 *
 * - 每条评论 = 一段块高亮（常驻背景色）+ 块末尾一个评论图标（hover 出气泡显示正文）。
 * - 锚点随文档编辑实时 `map`：块被整体删空 / 删除范围覆盖整块 → 锚点塌陷（`to<=from`）被丢弃，
 *   并通过 `onAnchorsRemoved` 通知上层把评论从存储里移除；块被改但仍有内容 → 锚点保留。
 * - 位置由本扩展权威维护；存储只保 which/正文/行号，靠 effect 双向对齐。
 */

export interface WorkbenchCommentAnchor {
  id: string
  from: number
  to: number
}

/** 整体替换当前编辑器的评论锚点（打开文件按行号再锚定时用）。 */
export const setWorkbenchCommentAnchorsEffect = StateEffect.define<WorkbenchCommentAnchor[]>()
/** 新增单条锚点（编辑器内「@评论」创建时用，携带精确选区偏移）。 */
export const addWorkbenchCommentAnchorEffect = StateEffect.define<WorkbenchCommentAnchor>()
/** 只保留给定 id 的锚点（存储侧删除/消费评论后回收装饰用）。 */
export const retainWorkbenchCommentAnchorsEffect = StateEffect.define<Set<string>>()

export interface WorkbenchCommentExtensionOptions {
  /** 当前 composition root 的评论读取器；省略时仅为兼容而读取默认仓库。 */
  getComment?: (id: string) => Nullable<WorkbenchComment>
  /** 锚点因文档编辑塌陷被自动丢弃时回调（把评论从存储移除）。 */
  onAnchorsRemoved: (ids: string[]) => void
  /** 锚点起止行随编辑变化时回调（回写存储行号，供展示与再锚定）。 */
  onAnchorLinesChanged: (updates: Array<{ id: string; startLine: number; endLine: number }>) => void
  /** 气泡内删除按钮点击回调。 */
  onDeleteComment: (id: string) => void
  /** 气泡内保存正文时回调。 */
  onUpdateComment: (id: string, body: string) => void
  /** 编辑按钮文案解析器。 */
  resolveEditLabel: () => string
  /** 保存按钮文案解析器。 */
  resolveSaveLabel: () => string
  /** 取消按钮文案解析器。 */
  resolveCancelLabel: () => string
  /** 删除按钮文案解析器（i18n 由上层注入，widget 在 React 之外，惰性读取避免 stale）。 */
  resolveDeleteLabel: () => string
  /**
   * 判断某个事务是否「外部整篇替换文档」（切换文件 / 外部改动同步）。
   * 这类事务不应把旧锚点当作「块被删除」——上层会随后按行号重新锚定。
   */
  isExternalDocReplace: (tr: Transaction) => boolean
}

interface WorkbenchCommentFieldValue {
  anchors: WorkbenchCommentAnchor[]
  deco: DecorationSet
}

const COMMENT_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<path fill="currentColor" d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 11.5H7.2l-3 2.4A.6.6 0 0 1 3.2 13.4V11.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z"/>' +
  '</svg>'

class WorkbenchCommentMarkerWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly onUpdateComment: (id: string, body: string) => void,
    private readonly onDeleteComment: (id: string) => void,
    private readonly resolveEditLabel: () => string,
    private readonly resolveSaveLabel: () => string,
    private readonly resolveCancelLabel: () => string,
    private readonly resolveDeleteLabel: () => string,
    private readonly readComment: (id: string) => Nullable<WorkbenchComment>
  ) {
    super()
  }

  public eq(other: WidgetType): boolean {
    return other instanceof WorkbenchCommentMarkerWidget && other.id === this.id
  }

  public toDOM(): HTMLElement {
    const comment = this.readComment(this.id)
    const root = document.createElement('span')
    root.className = 'cm-workbenchCommentMarker'
    root.setAttribute('data-comment-id', this.id)

    const icon = document.createElement('span')
    icon.className = 'cm-workbenchCommentMarkerIcon'
    icon.innerHTML = COMMENT_ICON_SVG
    root.appendChild(icon)

    const bubble = document.createElement('span')
    bubble.className = 'cm-workbenchCommentMarkerBubble'
    // 气泡是独立交互面，事件到此为止，避免 CodeMirror 在下层重新定位光标或选区。
    for (const eventName of [
      'pointerdown',
      'mousedown',
      'click',
      'dblclick',
      'contextmenu',
    ] as const) {
      bubble.addEventListener(eventName, (event) => event.stopPropagation())
    }

    const body = document.createElement('span')
    body.className = 'cm-workbenchCommentMarkerBody'
    body.textContent = comment?.body ?? ''
    bubble.appendChild(body)

    const editor = document.createElement('textarea')
    editor.className = 'cm-workbenchCommentMarkerEditor'
    editor.value = comment?.body ?? ''
    editor.rows = 3
    editor.spellcheck = false
    bubble.appendChild(editor)

    const actions = document.createElement('span')
    actions.className = 'cm-workbenchCommentMarkerActions'

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-workbenchCommentMarkerAction cm-workbenchCommentMarkerEdit'
    edit.textContent = this.resolveEditLabel()

    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'cm-workbenchCommentMarkerAction cm-workbenchCommentMarkerSave'
    save.textContent = this.resolveSaveLabel()

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'cm-workbenchCommentMarkerAction cm-workbenchCommentMarkerCancel'
    cancel.textContent = this.resolveCancelLabel()

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'cm-workbenchCommentMarkerAction cm-workbenchCommentMarkerDelete'
    remove.textContent = this.resolveDeleteLabel()

    const enterEditMode = (): void => {
      editor.value = body.textContent ?? ''
      save.disabled = !editor.value.trim()
      bubble.classList.add('is-editing')
      queueMicrotask(() => {
        editor.focus()
        editor.setSelectionRange(editor.value.length, editor.value.length)
      })
    }
    const exitEditMode = (): void => {
      bubble.classList.remove('is-editing')
      editor.value = body.textContent ?? ''
    }
    const saveBody = (): void => {
      const nextBody = editor.value.trim()
      if (!nextBody) return
      this.onUpdateComment(this.id, nextBody)
      body.textContent = nextBody
      exitEditMode()
    }
    const handleButtonMouseDown = (event: MouseEvent, action: () => void): void => {
      event.preventDefault()
      event.stopPropagation()
      action()
    }

    edit.addEventListener('mousedown', (event) => handleButtonMouseDown(event, enterEditMode))
    save.addEventListener('mousedown', (event) => handleButtonMouseDown(event, saveBody))
    cancel.addEventListener('mousedown', (event) => handleButtonMouseDown(event, exitEditMode))
    remove.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onDeleteComment(this.id)
    })
    editor.addEventListener('input', () => {
      save.disabled = !editor.value.trim()
    })
    editor.addEventListener('mousedown', (event) => event.stopPropagation())
    editor.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        exitEditMode()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        saveBody()
      }
    })

    actions.append(edit, cancel, save, remove)
    bubble.appendChild(actions)

    root.appendChild(bubble)
    return root
  }

  public ignoreEvent(): boolean {
    // Widget 内部自行处理交互，不再交给 CodeMirror 的编辑器事件管线。
    return true
  }
}

function dedupeAnchorsById(anchors: WorkbenchCommentAnchor[]): WorkbenchCommentAnchor[] {
  const byId = new Map<string, WorkbenchCommentAnchor>()
  for (const anchor of anchors) {
    if (anchor.to > anchor.from) byId.set(anchor.id, anchor)
  }
  return [...byId.values()]
}

function buildCommentDecorations(
  anchors: WorkbenchCommentAnchor[],
  options: WorkbenchCommentExtensionOptions
): DecorationSet {
  const ordered = [...anchors].sort((left, right) => left.from - right.from || left.to - right.to)
  const ranges: Array<Range<Decoration>> = []

  for (const anchor of ordered) {
    ranges.push(
      Decoration.mark({
        class: 'cm-workbenchCommentBlock',
        attributes: { 'data-comment-id': anchor.id },
      }).range(anchor.from, anchor.to)
    )
    ranges.push(
      Decoration.widget({
        widget: new WorkbenchCommentMarkerWidget(
          anchor.id,
          options.onUpdateComment,
          options.onDeleteComment,
          options.resolveEditLabel,
          options.resolveSaveLabel,
          options.resolveCancelLabel,
          options.resolveDeleteLabel,
          options.getComment ?? getWorkbenchComment
        ),
        side: 1,
      }).range(anchor.to)
    )
  }

  return Decoration.set(ranges, true)
}

export function createWorkbenchCommentExtension(
  options: WorkbenchCommentExtensionOptions
): Extension {
  const commentField = StateField.define<WorkbenchCommentFieldValue>({
    create: () => ({ anchors: [], deco: Decoration.none }),
    update(value, tr) {
      let anchors = value.anchors

      if (tr.docChanged) {
        if (options.isExternalDocReplace(tr)) {
          // 切换文件/外部整篇替换：旧偏移全作废，清空等上层按行号重锚（不算「块被删」）。
          anchors = []
        } else {
          anchors = anchors
            .map((anchor) => ({
              id: anchor.id,
              from: tr.changes.mapPos(anchor.from, 1),
              to: tr.changes.mapPos(anchor.to, -1),
            }))
            .filter((anchor) => anchor.to > anchor.from)
        }
      }

      for (const effect of tr.effects) {
        if (effect.is(setWorkbenchCommentAnchorsEffect)) {
          anchors = dedupeAnchorsById(effect.value)
        } else if (effect.is(addWorkbenchCommentAnchorEffect)) {
          if (effect.value.to > effect.value.from) {
            anchors = [...anchors.filter((anchor) => anchor.id !== effect.value.id), effect.value]
          }
        } else if (effect.is(retainWorkbenchCommentAnchorsEffect)) {
          const kept = anchors.filter((anchor) => effect.value.has(anchor.id))
          if (kept.length !== anchors.length) anchors = kept
        }
      }

      if (anchors === value.anchors) return value

      return { anchors, deco: buildCommentDecorations(anchors, options) }
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
  })

  const syncWatcher = EditorView.updateListener.of((update) => {
    const before = update.startState.field(commentField, false)
    const after = update.state.field(commentField, false)
    if (!before || !after || before.anchors === after.anchors) return

    // 外部整篇替换清空的锚点不是「删除评论」，跳过移除/行号回写通知。
    const isExternalReplace = update.transactions.some((tr) => options.isExternalDocReplace(tr))
    if (isExternalReplace) return

    const afterIds = new Set(after.anchors.map((anchor) => anchor.id))
    const removed = before.anchors
      .filter((anchor) => !afterIds.has(anchor.id))
      .map((anchor) => anchor.id)
    if (!isEmpty(removed)) options.onAnchorsRemoved(removed)

    if (update.docChanged) {
      const lineUpdates = after.anchors.map((anchor) => ({
        id: anchor.id,
        startLine: update.state.doc.lineAt(anchor.from).number,
        endLine: update.state.doc.lineAt(Math.max(anchor.from, anchor.to - 1)).number,
      }))
      if (!isEmpty(lineUpdates)) options.onAnchorLinesChanged(lineUpdates)
    }
  })

  const commentTheme = EditorView.theme({
    '.cm-workbenchCommentBlock': {
      backgroundColor: 'var(--workbench-editor-comment-block-bg, rgba(250, 204, 21, 0.16))',
      boxShadow: 'inset 2px 0 0 var(--workbench-editor-comment-block-accent, #f59e0b)',
      borderRadius: '2px',
    },
    '.cm-workbenchCommentMarker': {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '16px',
      height: '16px',
      marginLeft: '4px',
      verticalAlign: 'middle',
      borderRadius: '4px',
      color: 'var(--workbench-editor-comment-marker-fg, #b45309)',
      backgroundColor: 'var(--workbench-editor-comment-marker-bg, rgba(245, 158, 11, 0.18))',
      cursor: 'default',
    },
    '.cm-workbenchCommentMarkerIcon': {
      display: 'inline-flex',
    },
    '.cm-workbenchCommentMarkerBubble': {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      right: '0',
      zIndex: '20',
      display: 'none',
      boxSizing: 'border-box',
      width: '240px',
      maxWidth: 'calc(100vw - 32px)',
      padding: '10px 12px',
      borderRadius: '8px',
      backgroundColor: 'var(--workbench-editor-tooltip-bg, #ffffff)',
      border: '1px solid var(--workbench-editor-gutter-border, #d0d7e2)',
      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
      color: 'var(--workbench-editor-fg, #1f2937)',
      whiteSpace: 'normal',
      lineHeight: '1.5',
    },
    '.cm-workbenchCommentMarkerBubble::after': {
      content: '""',
      position: 'absolute',
      top: '100%',
      right: '0',
      width: '100%',
      height: '6px',
    },
    '.cm-workbenchCommentMarker:hover .cm-workbenchCommentMarkerBubble, .cm-workbenchCommentMarker:focus-within .cm-workbenchCommentMarkerBubble':
      {
        display: 'block',
      },
    '.cm-workbenchCommentMarkerBody': {
      display: 'block',
      fontSize: '12px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
    '.cm-workbenchCommentMarkerEditor': {
      display: 'none',
      boxSizing: 'border-box',
      width: '100%',
      minHeight: '66px',
      resize: 'vertical',
      padding: '6px 8px',
      border: '1px solid var(--workbench-border, #d0d7e2)',
      borderRadius: 'var(--workbench-radius-sm, 6px)',
      outline: 'none',
      font: 'inherit',
      lineHeight: '1.5',
      color: 'inherit',
      backgroundColor: 'var(--workbench-editor-tooltip-bg, #ffffff)',
    },
    '.cm-workbenchCommentMarkerEditor:focus': {
      borderColor: 'var(--workbench-editor-comment-marker-fg, #b45309)',
    },
    '.cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerBody': {
      display: 'none',
    },
    '.cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerEditor': {
      display: 'block',
    },
    '.cm-workbenchCommentMarkerActions': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '6px',
      marginTop: '8px',
    },
    '.cm-workbenchCommentMarkerAction': {
      padding: '3px 9px',
      border: 'none',
      borderRadius: '6px',
      fontSize: '11px',
      lineHeight: '1.4',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      color: 'var(--workbench-editor-fg, #1f2937)',
      backgroundColor: 'transparent',
    },
    '.cm-workbenchCommentMarkerDelete': {
      color: 'var(--workbench-editor-comment-marker-fg, #b45309)',
      backgroundColor: 'var(--workbench-editor-comment-marker-bg, rgba(245, 158, 11, 0.18))',
    },
    '.cm-workbenchCommentMarkerSave': {
      color: 'var(--workbench-editor-comment-marker-fg, #b45309)',
      backgroundColor: 'var(--workbench-editor-comment-marker-bg, rgba(245, 158, 11, 0.18))',
    },
    '.cm-workbenchCommentMarkerCancel, .cm-workbenchCommentMarkerSave': {
      display: 'none',
    },
    '.cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerEdit, .cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerDelete':
      {
        display: 'none',
      },
    '.cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerCancel, .cm-workbenchCommentMarkerBubble.is-editing .cm-workbenchCommentMarkerSave':
      {
        display: 'inline-block',
      },
    '.cm-workbenchCommentMarkerSave:disabled': {
      opacity: '0.45',
      cursor: 'not-allowed',
    },
  })

  return [commentField, syncWatcher, commentTheme]
}

/** 把 1 基起止行换算成当前文档里的块偏移；越界返回 `null`。 */
export function anchorFromLineRange(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  id: string,
  startLine: number,
  endLine: number
): Nullable<WorkbenchCommentAnchor> {
  if (startLine < 1 || startLine > doc.lines) return null
  const clampedEnd = Math.min(Math.max(startLine, endLine), doc.lines)
  const from = doc.line(startLine).from
  const to = doc.line(clampedEnd).to
  if (to <= from) return null
  return { id, from, to }
}
