import { type ChangeDesc, MapMode, type Text } from '@codemirror/state'

/**
 * 按行锚定的编辑器标记（讲解气泡、AI 选区、行内评论）共用的位置规则。
 *
 * 行锚点从起始行行首（`from`）到结束行行尾（`to`）；标在一个空行上时两者相等。
 */
export interface WorkbenchLineAnchorRange {
  from: number
  to: number
}

/**
 * 让一个行锚点跟着一次编辑走，返回对齐到整行的新位置；它标着的代码被删掉时返回 null。
 *
 * - 有内容的锚点：起点贴后、终点贴前各自映射，塌成零宽就是整段被删了。
 * - 空行上的锚点本来就是零宽，不能拿「塌成零宽」判删除：看这一行两侧的换行，任何一个被删，
 *   这一行就不在了（Backspace 并进上一行、Delete 把下一行拉上来、整行删掉都算）。
 */
export function mapWorkbenchLineAnchor<T extends WorkbenchLineAnchorRange>(
  anchor: T,
  changes: ChangeDesc,
  doc: Text
): T | null {
  let from: number
  let to: number
  if (anchor.to === anchor.from) {
    const before = changes.mapPos(anchor.from, -1, MapMode.TrackBefore)
    const after = changes.mapPos(anchor.from, -1, MapMode.TrackAfter)
    if (before === null || after === null) return null
    from = before
    to = before
  } else {
    from = changes.mapPos(anchor.from, 1)
    to = changes.mapPos(anchor.to, -1)
    if (to <= from) return null
  }
  return { ...anchor, from: doc.lineAt(from).from, to: doc.lineAt(to).to }
}

/**
 * 锚点标到第几行。行锚点的 `to` 就落在结束行上；从编辑器选区来的锚点（行内评论）连着换行选到了
 * 下一行行首时，那一行不算。空行的行首也是行尾，落在空行上就是那一行本身。
 */
export function resolveWorkbenchAnchorEndLine(doc: Text, anchor: WorkbenchLineAnchorRange): number {
  const line = doc.lineAt(anchor.to)
  return anchor.to > anchor.from && anchor.to === line.from && line.length > 0
    ? line.number - 1
    : line.number
}
