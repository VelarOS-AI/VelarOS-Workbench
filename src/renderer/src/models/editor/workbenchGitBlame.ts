/**
 * 编辑器里的 Git 追溯（blame）：行号左边多一栏，标出每一行最后是谁、什么时候改的，悬停看提交说明。
 *
 * 每一行的归属挂在行首的一个点上，随文档的改动移动；改过的行不再属于原来的提交，先空着，等下一次重新追溯
 * （保存、Git 状态变化之后）再补上。
 */
import {
  type EditorState,
  type Extension,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { gutter, GutterMarker } from '@codemirror/view'

import type { WorkbenchGitBlame, WorkbenchGitBlameCommit } from '@shared/workbenchGitBlame'

/** 换上一份追溯结果；null 是收起。 */
export const setWorkbenchGitBlame = StateEffect.define<Nullable<WorkbenchGitBlame>>()

class BlameLine extends RangeValue {
  // 跟着行首后面的那个字符走：在行首前插入整行时标记随这一行下移，这一行被删掉时标记也没了。
  // 点标记的两侧要一样，否则映射时会被当成反了的区间丢掉。
  override startSide = 1
  override endSide = 1
  override mapMode = MapMode.TrackAfter

  constructor(readonly commit: number) {
    super()
  }

  public override eq(other: RangeValue): boolean {
    return other instanceof BlameLine && other.commit === this.commit
  }
}

interface WorkbenchGitBlameState {
  commits: readonly WorkbenchGitBlameCommit[]
  lines: RangeSet<BlameLine>
}

function buildBlameLines(doc: Text, lines: readonly number[]): RangeSet<BlameLine> {
  const ranges = []
  for (let number = 1; number <= Math.min(doc.lines, lines.length); number += 1) {
    const commit = lines[number - 1]
    if (commit !== undefined && commit >= 0)
      ranges.push(new BlameLine(commit).range(doc.line(number).from))
  }
  return RangeSet.of(ranges)
}

export const workbenchGitBlameField = StateField.define<Nullable<WorkbenchGitBlameState>>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setWorkbenchGitBlame)) continue
      return effect.value
        ? {
            commits: effect.value.commits,
            lines: buildBlameLines(transaction.state.doc, effect.value.lines),
          }
        : null
    }
    if (!value || !transaction.docChanged) return value

    let lines = value.lines.map(transaction.changes)
    const before = transaction.startState.doc
    const doc = transaction.state.doc
    transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      // 整行整行地插入、删除：只有新插入的那几行不属于任何提交，前后的行原样。
      const wholeLines =
        before.lineAt(fromA).from === fromA &&
        before.lineAt(toA).from === toA &&
        (inserted.length === 0 || inserted.line(inserted.lines).length === 0)
      if (wholeLines && fromB === toB) return
      // 其余改动：碰到的行都不再算原提交的。
      const from = wholeLines ? fromB : doc.lineAt(fromB).from
      const to = wholeLines ? toB - 1 : doc.lineAt(toB).to
      lines = lines.update({ filterFrom: from, filterTo: to, filter: () => false })
    })
    return { commits: value.commits, lines }
  },
})

/** 某一行的归属；没有追溯结果、或这一行还没提交（刚改过）时是 null。 */
export function workbenchGitBlameAtLine(
  state: EditorState,
  lineNumber: number
): Nullable<WorkbenchGitBlameCommit> {
  const blame = state.field(workbenchGitBlameField, false)
  if (!blame || lineNumber < 1 || lineNumber > state.doc.lines) return null
  const index = commitIndexAt(blame, state.doc.line(lineNumber).from)
  return index === null ? null : (blame.commits[index] ?? null)
}

function commitIndexAt(blame: WorkbenchGitBlameState, lineStart: number): Nullable<number> {
  let found: Nullable<number> = null
  blame.lines.between(lineStart, lineStart, (_from, _to, value) => {
    found = value.commit
    return false
  })
  return found
}

class BlameMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly title: string
  ) {
    super()
  }

  public override eq(other: GutterMarker): boolean {
    return other instanceof BlameMarker && other.label === this.label && other.title === this.title
  }

  public override toDOM(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'cm-workbenchBlameLine'
    element.textContent = this.label
    element.title = this.title
    return element
  }
}

const MaxAuthorLength = 14

/**
 * 追溯栏。`locale` 决定日期怎么写。同一个提交连着的几行只在第一行写「日期 作者」，其余行留空（悬停仍能看到）。
 */
export function workbenchGitBlameGutter(locale: string): Extension {
  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const describe = (commit: WorkbenchGitBlameCommit, first: boolean): BlameMarker => {
    const when = new Date(commit.authorTime * 1000)
    const author =
      commit.author.length > MaxAuthorLength
        ? `${commit.author.slice(0, MaxAuthorLength - 1)}…`
        : commit.author
    return new BlameMarker(
      first ? `${dateFormat.format(when)} ${author}` : '',
      `${commit.summary}\n${commit.author} · ${dateTimeFormat.format(when)}\n${commit.sha.slice(0, 8)}`
    )
  }

  return [
    workbenchGitBlameField,
    gutter({
      class: 'cm-workbenchBlameGutter',
      lineMarker(view, line) {
        const blame = view.state.field(workbenchGitBlameField, false)
        if (!blame) return null
        const index = commitIndexAt(blame, line.from)
        const commit = index === null ? undefined : blame.commits[index]
        if (index === null || !commit) return null
        const previous =
          line.from > 0 ? commitIndexAt(blame, view.state.doc.lineAt(line.from - 1).from) : null
        return describe(commit, previous !== index)
      },
      lineMarkerChange: (update) =>
        update.startState.field(workbenchGitBlameField, false) !==
        update.state.field(workbenchGitBlameField, false),
    }),
  ]
}
