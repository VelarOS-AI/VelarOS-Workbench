/**
 * 测试文件的 ▶ 栏：第一行的 ▶ 跑整个文件，每个 `describe` / `it` / `test` 旁边的 ▶ 只跑它自己，跑完标记换成
 * 上一次的结果（通过 / 没通过）。▶ 右边是「调试」：同一个测试，由调试器带着起。
 *
 * 标记只给可见区里的块算（见 `workbenchTestBlocks.ts`），文档、可见区或语法树变了才重算。算好的标记按需取：
 * 标记栏比这里的插件先更新，由标记栏来要的时候才算，拿到的总是当前这一版文档的。
 */
import { syntaxTree } from '@codemirror/language'
import {
  type EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  type Text,
} from '@codemirror/state'
import { type EditorView, gutter, GutterMarker, ViewPlugin } from '@codemirror/view'

import { registerWorkbenchEditorActions } from './workbenchEditorActions'
import { collectWorkbenchTestBlocks, findWorkbenchTestBlockAt } from './workbenchTestBlocks'
import type { WorkbenchTestRunStatus } from './workbenchTestRunResults'

/** 要跑的东西：一个测试、一组测试，或者整个文件。 */
export interface WorkbenchTestRunTarget {
  kind: 'file' | 'suite' | 'test'
  /** 交给运行器 `-t` 的全名正则；整个文件为 null。 */
  pattern: Nullable<string>
  /** 源码里的标题；整个文件是空串。 */
  title: string
}

export interface WorkbenchTestRunGutterLabels {
  runFile: string
  runTest: (title: string) => string
  runSuite: (title: string) => string
  debugFile: string
  debugTest: (title: string) => string
  debugSuite: (title: string) => string
  status: Record<WorkbenchTestRunStatus, string>
}

export interface WorkbenchTestRunGutterOptions {
  labels: WorkbenchTestRunGutterLabels
  /** 这个目标上一次运行的结果；没跑过（或被停掉了）是 null。 */
  readStatus: (target: WorkbenchTestRunTarget) => Nullable<WorkbenchTestRunStatus>
  /** 结果变了就通知：标记要换。 */
  subscribeStatus: (listener: () => void) => () => void
  /** `view` 是点的那个编辑器：选运行器要看这个文件自己引的是谁。 */
  onRun: (target: WorkbenchTestRunTarget, view: EditorView) => void
  /** 调试这个目标（同一个测试，由调试器带着起）。 */
  onDebug: (target: WorkbenchTestRunTarget, view: EditorView) => void
}

export interface WorkbenchTestRunGutterLine {
  /** 标记所在行的行首位置。 */
  position: number
  target: WorkbenchTestRunTarget
}

const FileTarget: WorkbenchTestRunTarget = { kind: 'file', pattern: null, title: '' }
const SvgNamespace = 'http://www.w3.org/2000/svg'
/** 调试按钮上的小虫（Phosphor 的 Bug，regular 粗细）。 */
const BugIconPath =
  'M144,92a12,12,0,1,1,12,12A12,12,0,0,1,144,92ZM100,80a12,12,0,1,0,12,12A12,12,0,0,0,100,80Zm116,64A87.76,87.76,0,0,1,213,167l22.24,9.72A8,8,0,0,1,232,192a7.89,7.89,0,0,1-3.2-.67L207.38,182a88,88,0,0,1-158.76,0L27.2,191.33A7.89,7.89,0,0,1,24,192a8,8,0,0,1-3.2-15.33L43,167A87.76,87.76,0,0,1,40,144v-8H16a8,8,0,0,1,0-16H40v-8a87.76,87.76,0,0,1,3-23L20.8,79.33a8,8,0,1,1,6.4-14.66L48.62,74a88,88,0,0,1,158.76,0l21.42-9.36a8,8,0,0,1,6.4,14.66L213,89.05a87.76,87.76,0,0,1,3,23v8h24a8,8,0,0,1,0,16H216ZM56,120H200v-8a72,72,0,0,0-144,0Zm64,95.54V136H56v8A72.08,72.08,0,0,0,120,215.54ZM200,144v-8H136v79.54A72.08,72.08,0,0,0,200,144Z'
/** 只为让标记栏重画一次（结果变了，文档没变）。 */
const refreshTestRunMarkers = StateEffect.define<null>()

/**
 * `[from, to]` 里该有 ▶ 的行。第一行总是「跑整个文件」；一行上有几个块时只标最外面那个。
 */
export function buildWorkbenchTestRunGutterLines(
  state: EditorState,
  from: number,
  to: number
): WorkbenchTestRunGutterLine[] {
  const lines: WorkbenchTestRunGutterLine[] = from === 0 ? [{ position: 0, target: FileTarget }] : []
  let lastPosition = lines.length > 0 ? 0 : -1
  for (const block of collectWorkbenchTestBlocks(state, from, to)) {
    const position = state.doc.lineAt(block.from).from
    // 外层 describe 的开头可能在范围之上：它的标记不归这一段管。
    if (position < from || position <= lastPosition) continue

    lastPosition = position
    lines.push({
      position,
      target: { kind: block.kind, pattern: block.pattern, title: block.title },
    })
  }
  return lines
}

class WorkbenchTestRunMarker extends GutterMarker {
  public constructor(
    private readonly target: WorkbenchTestRunTarget,
    private readonly status: Nullable<WorkbenchTestRunStatus>,
    private readonly options: WorkbenchTestRunGutterOptions
  ) {
    super()
  }

  public override eq(other: GutterMarker): boolean {
    return (
      other instanceof WorkbenchTestRunMarker &&
      other.target.kind === this.target.kind &&
      other.target.pattern === this.target.pattern &&
      other.target.title === this.target.title &&
      other.status === this.status &&
      other.options === this.options
    )
  }

  public override toDOM(view: EditorView): Node {
    const { labels } = this.options
    const action =
      this.target.kind === 'file'
        ? labels.runFile
        : this.target.kind === 'suite'
          ? labels.runSuite(this.target.title)
          : labels.runTest(this.target.title)
    const label = this.status ? `${action} · ${labels.status[this.status]}` : action

    const button = this.createButton('cm-workbenchRunButton cm-workbenchTestRunButton', label, () =>
      this.options.onRun(this.target, view)
    )
    if (this.status) button.dataset.testStatus = this.status

    const icon = document.createElement('span')
    icon.setAttribute('aria-hidden', 'true')
    // 跑过的显示结果（✓ / ✕），没跑过、正在跑的都是 ▶（正在跑的由样式做成闪动）。点它总是再跑一次。
    if (this.status === 'passed' || this.status === 'failed') {
      icon.className = 'cm-workbenchTestResultIcon'
      icon.textContent = this.status === 'passed' ? '✓' : '✕'
    } else {
      icon.className = 'cm-workbenchRunIcon'
    }
    button.append(icon)

    const debugLabel =
      this.target.kind === 'file'
        ? labels.debugFile
        : this.target.kind === 'suite'
          ? labels.debugSuite(this.target.title)
          : labels.debugTest(this.target.title)
    const debugButton = this.createButton(
      'cm-workbenchRunButton cm-workbenchTestDebugButton',
      debugLabel,
      () => this.options.onDebug(this.target, view)
    )
    const bug = document.createElementNS(SvgNamespace, 'svg')
    bug.setAttribute('viewBox', '0 0 256 256')
    bug.setAttribute('fill', 'currentColor')
    bug.setAttribute('aria-hidden', 'true')
    bug.setAttribute('class', 'cm-workbenchTestDebugIcon')
    bug.append(document.createElementNS(SvgNamespace, 'path'))
    bug.firstElementChild?.setAttribute('d', BugIconPath)
    debugButton.append(bug)

    const cell = document.createElement('span')
    cell.className = 'cm-workbenchTestRunCell'
    cell.append(button, debugButton)
    return cell
  }

  private createButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.title = label
    button.setAttribute('aria-label', label)
    // 不让点击把光标挪到这一行、把焦点从编辑器里抢走。
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    return button
  }
}

export function createWorkbenchTestRunGutterExtension(
  options: WorkbenchTestRunGutterOptions
): Extension {
  const markers = ViewPlugin.fromClass(
    class {
      private cached: Nullable<{
        doc: Text
        tree: ReturnType<typeof syntaxTree>
        from: number
        to: number
        version: number
        markers: RangeSet<GutterMarker>
      }> = null
      private version = 0
      private readonly unsubscribeStatus: () => void
      private readonly unregisterActions: () => void

      public constructor(view: EditorView) {
        this.unsubscribeStatus = options.subscribeStatus(() => {
          this.version += 1
          view.dispatch({ effects: refreshTestRunMarkers.of(null) })
        })
        // 命令面板里的「运行当前文件的测试」「运行 / 调试光标处的测试」：这个编辑器在，就由它来做。
        const targetAtCursor = (): WorkbenchTestRunTarget => {
          const block = findWorkbenchTestBlockAt(view.state, view.state.selection.main.head)
          return block ? { kind: block.kind, pattern: block.pattern, title: block.title } : FileTarget
        }
        this.unregisterActions = registerWorkbenchEditorActions(view, {
          'run-test-file': () => options.onRun(FileTarget, view),
          'run-test-at-cursor': () => options.onRun(targetAtCursor(), view),
          'debug-test-at-cursor': () => options.onDebug(targetAtCursor(), view),
        })
      }

      public read(view: EditorView): RangeSet<GutterMarker> {
        const { state, viewport } = view
        const tree = syntaxTree(state)
        const cached = this.cached
        if (
          cached &&
          cached.doc === state.doc &&
          cached.tree === tree &&
          cached.from === viewport.from &&
          cached.to === viewport.to &&
          cached.version === this.version
        )
          return cached.markers

        const next = RangeSet.of(
          buildWorkbenchTestRunGutterLines(state, viewport.from, viewport.to).map((line) =>
            new WorkbenchTestRunMarker(
              line.target,
              options.readStatus(line.target),
              options
            ).range(line.position)
          )
        )
        this.cached = {
          doc: state.doc,
          tree,
          from: viewport.from,
          to: viewport.to,
          version: this.version,
          markers: next,
        }
        return next
      }

      public destroy(): void {
        this.unsubscribeStatus()
        this.unregisterActions()
      }
    }
  )

  return [
    markers,
    gutter({
      class: 'cm-workbenchRunGutter',
      markers: (view) => view.plugin(markers)?.read(view) ?? RangeSet.empty,
    }),
  ]
}
