import { isolateHistory } from '@codemirror/commands'
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { diffArrays } from 'diff'

/**
 * 编辑区里的合并冲突：认出 `<<<<<<<`、`|||||||`（diff3 的共同祖先）、`=======`、`>>>>>>>` 围起来的冲突块，
 * 当前（我方）与传入（对方）两段各着一种底色，块上方一排按钮：采用当前 | 采用传入 | 保留两者 | 对比。
 * 选了一边就把整块换成那一边，一次事务、一步撤回；「对比」在块里标出两边不同的行。
 *
 * 冲突块和对比开关都记在编辑器状态里：每个文件的状态各带一份，切走再切回来互不干扰。
 */

export interface WorkbenchMergeConflictRange {
  from: number
  to: number
}

export interface WorkbenchMergeConflictBlock {
  /** 整块：`<<<<<<<` 行首到 `>>>>>>>` 行尾（含它的换行）。 */
  from: number
  to: number
  /** 各段正文（不含标记行，含最后一行的换行）；diff3 才有共同祖先那一段。 */
  current: WorkbenchMergeConflictRange
  base: Nullable<WorkbenchMergeConflictRange>
  incoming: WorkbenchMergeConflictRange
  /** 各标记行的行首；没有共同祖先时 `baseMarker` 为 null。 */
  startMarker: number
  baseMarker: Nullable<number>
  separator: number
  endMarker: number
}

export type WorkbenchMergeConflictResolution = 'current' | 'incoming' | 'both'

/** 按钮、标记行说明上的字：`workbench.mergeConflict.<键>`。 */
type WorkbenchMergeConflictMessageKey =
  | 'acceptCurrent'
  | 'acceptIncoming'
  | 'acceptBoth'
  | 'compare'
  | 'stopCompare'
  | 'currentChange'
  | 'incomingChange'

/** 编辑器的翻译函数（按 i18n 键取当前语言的字；没有这个键时原样返回键）。 */
export type WorkbenchMergeConflictTranslate = (key: string) => string

const DefaultMessages: Record<WorkbenchMergeConflictMessageKey, string> = {
  acceptCurrent: 'Accept Current',
  acceptIncoming: 'Accept Incoming',
  acceptBoth: 'Accept Both',
  compare: 'Compare',
  stopCompare: 'Stop Comparing',
  currentChange: '(Current Change)',
  incomingChange: '(Incoming Change)',
}

function message(
  translate: WorkbenchMergeConflictTranslate,
  key: WorkbenchMergeConflictMessageKey
): string {
  const messageKey = `workbench.mergeConflict.${key}`
  const text = translate(messageKey)
  return text && text !== messageKey ? text : DefaultMessages[key]
}

const StartMarker = /^<{7}(?:[ \t]|$)/u
const BaseMarker = /^\|{7}(?:[ \t]|$)/u
const Separator = /^={7}[ \t]*$/u
const EndMarker = /^>{7}(?:[ \t]|$)/u

/** 以这几个字符开头的行才可能是标记：`<`、`|`、`=`、`>`。 */
const MarkerFirstCharacters = new Set([60, 124, 61, 62])

/** 某一种标记行在块里的位置：行首与下一行的行首。 */
interface MarkerLine {
  from: number
  next: number
}

function isMarkerLine(text: string): boolean {
  return (
    MarkerFirstCharacters.has(text.charCodeAt(0)) &&
    (StartMarker.test(text) || BaseMarker.test(text) || Separator.test(text) || EndMarker.test(text))
  )
}

/** 找出文档里完整的冲突块（开头、分隔、结尾都在）；不完整的不算。逐行扫一遍，只细看以标记字符开头的行。 */
export function findWorkbenchMergeConflicts(doc: Text): WorkbenchMergeConflictBlock[] {
  const blocks: WorkbenchMergeConflictBlock[] = []
  let start: Nullable<MarkerLine> = null
  let baseMarker: Nullable<MarkerLine> = null
  let separator: Nullable<MarkerLine> = null
  let from = 0
  for (const text of doc.iterLines()) {
    const line = { from, next: from + text.length + 1 }
    from = line.next
    if (!MarkerFirstCharacters.has(text.charCodeAt(0))) continue
    if (StartMarker.test(text)) {
      // 又一个开头：前一块没收尾，不算。
      start = line
      baseMarker = null
      separator = null
    } else if (start === null) {
      continue
    } else if (separator === null && baseMarker === null && BaseMarker.test(text)) {
      baseMarker = line
    } else if (separator === null && Separator.test(text)) {
      separator = line
    } else if (separator !== null && EndMarker.test(text)) {
      blocks.push({
        from: start.from,
        to: Math.min(line.next, doc.length),
        current: { from: start.next, to: (baseMarker ?? separator).from },
        base: baseMarker ? { from: baseMarker.next, to: separator.from } : null,
        incoming: { from: separator.next, to: line.from },
        startMarker: start.from,
        baseMarker: baseMarker?.from ?? null,
        separator: separator.from,
        endMarker: line.from,
      })
      start = null
      baseMarker = null
      separator = null
    }
  }
  return blocks
}

/** 这次改动碰到的行（改动后的文档里）有没有长得像冲突标记的。 */
function touchesMarkerLine(tr: Transaction): boolean {
  let touched = false
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    for (let pos = fromB; !touched; ) {
      const line = tr.state.doc.lineAt(pos)
      if (isMarkerLine(line.text)) touched = true
      if (line.to >= toB || line.number >= tr.state.doc.lines) break
      pos = line.to + 1
    }
  })
  return touched
}

/** 选定一边之后这一块该换成的正文。 */
export function resolveWorkbenchMergeConflictText(
  doc: Text,
  block: WorkbenchMergeConflictBlock,
  resolution: WorkbenchMergeConflictResolution
): string {
  const current = doc.sliceString(block.current.from, block.current.to)
  const incoming = doc.sliceString(block.incoming.from, block.incoming.to)
  if (resolution === 'current') return current
  if (resolution === 'incoming') return incoming
  return current + incoming
}

/**
 * 把这一块换成选定那一边的事务：一次替换，自成一步撤回（不跟前后的输入并在一起），撤回就回到带冲突标记的样子。
 */
export function buildWorkbenchMergeConflictResolution(
  state: EditorState,
  block: WorkbenchMergeConflictBlock,
  resolution: WorkbenchMergeConflictResolution
): TransactionSpec {
  return {
    changes: {
      from: block.from,
      to: block.to,
      insert: resolveWorkbenchMergeConflictText(state.doc, block, resolution),
    },
    selection: { anchor: block.from },
    scrollIntoView: true,
    userEvent: 'input.resolveConflict',
    annotations: isolateHistory.of('full'),
  }
}

/** 把这一块换成选定的那一边；只读时什么也不做。 */
export function applyWorkbenchMergeConflictResolution(
  view: EditorView,
  block: WorkbenchMergeConflictBlock,
  resolution: WorkbenchMergeConflictResolution
): void {
  if (view.state.readOnly) return
  view.dispatch(buildWorkbenchMergeConflictResolution(view.state, block, resolution))
}

const mergeConflictTranslate = Facet.define<
  WorkbenchMergeConflictTranslate,
  WorkbenchMergeConflictTranslate
>({
  combine: (values) => values[0] ?? ((key) => key),
})

/** 切换某一块的「对比」，按块开头的位置认块。 */
const toggleCompareEffect = StateEffect.define<number>()

interface MergeConflictState {
  blocks: WorkbenchMergeConflictBlock[]
  /** 开着对比的块（块开头的位置，随文档改动挪动）。 */
  comparing: ReadonlySet<number>
  decorations: DecorationSet
}

/** 一段范围里各行的行首与正文。 */
function linesIn(doc: Text, range: WorkbenchMergeConflictRange): Array<{ from: number; text: string }> {
  const lines: Array<{ from: number; text: string }> = []
  if (range.to <= range.from) return lines
  for (let line = doc.lineAt(range.from); ; line = doc.line(line.number + 1)) {
    lines.push({ from: line.from, text: line.text })
    if (line.to + 1 >= range.to || line.number >= doc.lines) break
  }
  return lines
}

function lineClass(pos: number, className: string): Range<Decoration> {
  return Decoration.line({ class: className }).range(pos)
}

/** 块里各行按所在的段着色；标记行颜色深一档。 */
function blockLineClasses(doc: Text, block: WorkbenchMergeConflictBlock): Array<Range<Decoration>> {
  const ranges = [
    lineClass(block.startMarker, 'cm-mergeConflictMarker cm-mergeConflictMarker-current'),
    ...linesIn(doc, block.current).map((line) => lineClass(line.from, 'cm-mergeConflictCurrent')),
    lineClass(block.separator, 'cm-mergeConflictMarker cm-mergeConflictMarker-separator'),
    ...linesIn(doc, block.incoming).map((line) => lineClass(line.from, 'cm-mergeConflictIncoming')),
    lineClass(block.endMarker, 'cm-mergeConflictMarker cm-mergeConflictMarker-incoming'),
  ]
  if (block.baseMarker !== null)
    ranges.push(lineClass(block.baseMarker, 'cm-mergeConflictMarker cm-mergeConflictMarker-base'))
  if (block.base)
    ranges.push(...linesIn(doc, block.base).map((line) => lineClass(line.from, 'cm-mergeConflictBase')))
  return ranges
}

/** 对比：只在一边有的行加一道竖线，两边都有的行淡下去。 */
function compareLineClasses(doc: Text, block: WorkbenchMergeConflictBlock): Array<Range<Decoration>> {
  const current = linesIn(doc, block.current)
  const incoming = linesIn(doc, block.incoming)
  const ranges: Array<Range<Decoration>> = []
  let currentIndex = 0
  let incomingIndex = 0
  for (const part of diffArrays(
    current.map((line) => line.text),
    incoming.map((line) => line.text)
  )) {
    const count = part.value.length
    const currentLines = part.added ? [] : current.slice(currentIndex, currentIndex + count)
    const incomingLines = part.removed ? [] : incoming.slice(incomingIndex, incomingIndex + count)
    const className = part.added || part.removed ? 'cm-mergeConflictOnlyHere' : 'cm-mergeConflictSame'
    for (const line of [...currentLines, ...incomingLines]) ranges.push(lineClass(line.from, className))
    currentIndex += currentLines.length
    incomingIndex += incomingLines.length
  }
  return ranges
}

class MergeConflictActionsWidget extends WidgetType {
  public constructor(
    private readonly blockFrom: number,
    private readonly comparing: boolean,
    private readonly translate: WorkbenchMergeConflictTranslate
  ) {
    super()
  }

  public override eq(other: MergeConflictActionsWidget): boolean {
    return (
      other.blockFrom === this.blockFrom &&
      other.comparing === this.comparing &&
      other.translate === this.translate
    )
  }

  public override toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-mergeConflictActions'
    const actions: Array<[WorkbenchMergeConflictMessageKey, () => void]> = [
      ['acceptCurrent', () => this.resolve(view, 'current')],
      ['acceptIncoming', () => this.resolve(view, 'incoming')],
      ['acceptBoth', () => this.resolve(view, 'both')],
      [
        this.comparing ? 'stopCompare' : 'compare',
        () => view.dispatch(toggleWorkbenchMergeConflictCompare(this.blockFrom)),
      ],
    ]
    actions.forEach(([key, run], index) => {
      if (index > 0) {
        const separator = document.createElement('span')
        separator.className = 'cm-mergeConflictActionSeparator'
        separator.textContent = '|'
        separator.setAttribute('aria-hidden', 'true')
        bar.append(separator)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-mergeConflictAction'
      button.textContent = message(this.translate, key)
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', (event) => {
        event.preventDefault()
        run()
      })
      bar.append(button)
    })
    return bar
  }

  public override ignoreEvent(): boolean {
    return true
  }

  /** 按块现在的位置找块：按钮画出来之后文档可能又改过。 */
  private resolve(view: EditorView, resolution: WorkbenchMergeConflictResolution): void {
    const block = readWorkbenchMergeConflicts(view.state).find(
      (candidate) => candidate.from === this.blockFrom
    )
    if (block) applyWorkbenchMergeConflictResolution(view, block, resolution)
  }
}

/** 标记行尾的淡色说明：「当前更改」「传入的更改」。 */
class MergeConflictLabelWidget extends WidgetType {
  public constructor(private readonly label: string) {
    super()
  }

  public override eq(other: MergeConflictLabelWidget): boolean {
    return other.label === this.label
  }

  public override toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'cm-mergeConflictLabel'
    label.textContent = this.label
    return label
  }
}

function buildDecorations(
  state: EditorState,
  blocks: readonly WorkbenchMergeConflictBlock[],
  comparing: ReadonlySet<number>
): DecorationSet {
  const translate = state.facet(mergeConflictTranslate)
  const { doc } = state
  const ranges: Array<Range<Decoration>> = []
  for (const block of blocks) {
    const isComparing = comparing.has(block.from)
    // 只读时（文件太大、切到了只读）只着色，不给按钮。
    if (!state.readOnly)
      ranges.push(
        Decoration.widget({
          widget: new MergeConflictActionsWidget(block.from, isComparing, translate),
          block: true,
          side: -1,
        }).range(block.from)
      )
    ranges.push(
      Decoration.widget({
        widget: new MergeConflictLabelWidget(message(translate, 'currentChange')),
        side: 1,
      }).range(doc.lineAt(block.startMarker).to),
      Decoration.widget({
        widget: new MergeConflictLabelWidget(message(translate, 'incomingChange')),
        side: 1,
      }).range(doc.lineAt(block.endMarker).to),
      ...blockLineClasses(doc, block),
      ...(isComparing ? compareLineClasses(doc, block) : [])
    )
  }
  return Decoration.set(ranges, true)
}

function computeState(state: EditorState, comparing: ReadonlySet<number>): MergeConflictState {
  const blocks = findWorkbenchMergeConflicts(state.doc)
  // 块没了（解决掉了）就不再记它的对比开关。
  const kept = new Set([...comparing].filter((from) => blocks.some((block) => block.from === from)))
  return { blocks, comparing: kept, decorations: buildDecorations(state, blocks, kept) }
}

const mergeConflictField = StateField.define<MergeConflictState>({
  create: (state) => computeState(state, new Set()),
  update(value, tr) {
    let comparing = value.comparing
    for (const effect of tr.effects) {
      if (!effect.is(toggleCompareEffect)) continue
      const next = new Set(comparing)
      if (next.has(effect.value)) next.delete(effect.value)
      else next.add(effect.value)
      comparing = next
    }
    if (tr.docChanged) comparing = new Set([...comparing].map((from) => tr.changes.mapPos(from, 1)))
    const readOnlyChanged = tr.startState.readOnly !== tr.state.readOnly
    if (!tr.docChanged && comparing === value.comparing && !readOnlyChanged) return value
    // 没有冲突的文件照常打字：改到的行里没有像标记的，就不可能冒出新的冲突块，不用重扫整个文档。
    if (value.blocks.length === 0 && !readOnlyChanged && !touchesMarkerLine(tr)) return value
    return computeState(tr.state, comparing)
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** 状态里现在认出的冲突块；没装这个扩展时为空。 */
export function readWorkbenchMergeConflicts(
  state: EditorState
): readonly WorkbenchMergeConflictBlock[] {
  return state.field(mergeConflictField, false)?.blocks ?? []
}

/** 这一块开着对比没有。 */
export function isWorkbenchMergeConflictComparing(state: EditorState, blockFrom: number): boolean {
  return !!state.field(mergeConflictField, false)?.comparing.has(blockFrom)
}

/** 开关某一块的对比（与块上方的「对比」按钮同一个动作）。 */
export function toggleWorkbenchMergeConflictCompare(blockFrom: number): TransactionSpec {
  return { effects: toggleCompareEffect.of(blockFrom) }
}

/** 装饰里标成某一类的各行行号（测试与调试用）：`current`、`incoming`、`base`、`only`（对比时只在一边）、`same`。 */
export function collectWorkbenchMergeConflictLineKinds(
  state: EditorState
): Record<'current' | 'incoming' | 'base' | 'only' | 'same', number[]> {
  const kinds: Record<'current' | 'incoming' | 'base' | 'only' | 'same', number[]> = {
    current: [],
    incoming: [],
    base: [],
    only: [],
    same: [],
  }
  const classes: Array<[string, keyof typeof kinds]> = [
    ['cm-mergeConflictCurrent', 'current'],
    ['cm-mergeConflictIncoming', 'incoming'],
    ['cm-mergeConflictBase', 'base'],
    ['cm-mergeConflictOnlyHere', 'only'],
    ['cm-mergeConflictSame', 'same'],
  ]
  state.field(mergeConflictField, false)?.decorations.between(0, state.doc.length, (from, _to, value) => {
    const className = (value.spec as { class?: string }).class
    const kind = classes.find(([candidate]) => candidate === className)?.[1]
    if (kind) kinds[kind].push(state.doc.lineAt(from).number)
  })
  return kinds
}

const mergeConflictTheme = EditorView.baseTheme({
  '.cm-mergeConflictCurrent': {
    backgroundColor: 'color-mix(in srgb, var(--status-green, #15803d) 12%, transparent)',
  },
  '.cm-mergeConflictIncoming': {
    backgroundColor: 'color-mix(in srgb, var(--status-blue, #2563eb) 12%, transparent)',
  },
  '.cm-mergeConflictBase': {
    backgroundColor: 'color-mix(in srgb, var(--muted-foreground, #6b7280) 10%, transparent)',
  },
  '.cm-mergeConflictMarker': { fontWeight: '600' },
  '.cm-mergeConflictMarker-current': {
    backgroundColor: 'color-mix(in srgb, var(--status-green, #15803d) 24%, transparent)',
  },
  '.cm-mergeConflictMarker-incoming': {
    backgroundColor: 'color-mix(in srgb, var(--status-blue, #2563eb) 24%, transparent)',
  },
  '.cm-mergeConflictMarker-base, .cm-mergeConflictMarker-separator': {
    backgroundColor: 'color-mix(in srgb, var(--muted-foreground, #6b7280) 18%, transparent)',
  },
  '.cm-mergeConflictOnlyHere': {
    boxShadow: 'inset 3px 0 0 var(--status-amber, #d97706)',
  },
  '.cm-mergeConflictSame': { opacity: '0.55' },
  '.cm-mergeConflictLabel': {
    marginLeft: '1.5em',
    color: 'var(--muted-foreground, #6b7280)',
    fontFamily: 'var(--font-sans, system-ui)',
    fontSize: '0.85em',
    fontWeight: '400',
    userSelect: 'none',
  },
  '.cm-mergeConflictActions': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '2px 0 1px',
    color: 'var(--muted-foreground, #6b7280)',
    fontFamily: 'var(--font-sans, system-ui)',
    fontSize: '11px',
    lineHeight: '16px',
  },
  '.cm-mergeConflictAction': {
    padding: '0 4px',
    border: '0',
    borderRadius: '3px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  '.cm-mergeConflictAction:hover': {
    color: 'var(--workbench-theme-color, #2563eb)',
    textDecoration: 'underline',
  },
  '.cm-mergeConflictActionSeparator': { opacity: '0.5' },
})

/**
 * 合并冲突的编辑扩展，放进每个文件的扩展列表里。`translate` 是编辑器的翻译函数（传一个读当前语言的，
 * 切了语言之后新画出来的按钮就是新语言），字取 `workbench.mergeConflict.*`，缺了用英文。
 */
export function workbenchMergeConflictExtension(
  translate: WorkbenchMergeConflictTranslate
): Extension {
  return [mergeConflictTranslate.of(translate), mergeConflictField, mergeConflictTheme]
}
