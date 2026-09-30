/**
 * 提交图的泳道排布。输入是按「子提交在前、父提交在后」排好的提交（`git log --date-order` 的顺序），
 * 输出每一行怎么画：提交落在第几条泳道，哪些泳道从这一行直穿过去，哪些在这个提交会合，它往下接到哪几条。
 *
 * 泳道是固定的列：一条线从分支的最新提交起占一列，沿第一个父提交一路往下，到它的父提交那一行为止；
 * 空出来的列给后来的分支接着用，别的线不挪位置，所以一条线从头到尾是直的。排布只看提交和父提交，
 * 不碰界面；可以接着上一页的收尾状态往下排，翻页不用从头算。
 */

export interface WorkbenchGitGraphCommit {
  sha: string
  /** 主线（第一个父提交）在前。 */
  parents: readonly string[]
}

export interface WorkbenchGitGraphRow {
  /** 这个提交所在的泳道，从 0 起。 */
  lane: number
  /** 上面有线接到这个提交（它的子提交已经出现过）。分支最新的那个提交没有。 */
  fromAbove: boolean
  /** 从这一行直穿过去的别的泳道。 */
  passing: number[]
  /** 在这个提交会合的别的泳道：这些线的子提交在别的列，走到这里并进来，那一列到此空出。 */
  mergingIn: number[]
  /**
   * 这个提交往下接到的泳道：第一个父提交留在提交自己的泳道里（根提交没有）；合并提交的其余父提交
   * 各接一条，已经有线在等那个父提交就接到那条线上，没有就另占一列。
   */
  branchingOut: number[]
  /** 这一行用到的泳道数（最右边一条的序号加一）。 */
  width: number
}

/** 排到某一行为止的状态：每条泳道在等哪个提交（那条线接下来要连到它），空着的为 null。 */
export interface WorkbenchGitGraphState {
  lanes: ReadonlyArray<Nullable<string>>
}

export interface WorkbenchGitGraphLayout {
  rows: WorkbenchGitGraphRow[]
  /** 排完这些提交之后的状态，交给下一页接着排。 */
  state: WorkbenchGitGraphState
}

export const EmptyWorkbenchGitGraphState: WorkbenchGitGraphState = { lanes: [] }

function firstFreeLane(lanes: Array<Nullable<string>>, from = 0): number {
  for (let index = from; index < lanes.length; index += 1) if (lanes[index] === null) return index
  return lanes.length
}

/**
 * 排一段提交。`state` 是上一段排完的状态，从头排时不给。
 *
 * 父提交不在这段里（被翻页截断、或者不在所看的范围里）时，等它的那条线一直开着，接到下一页；
 * 同一个父提交被好几条线等着时，它们各走各的列，到父提交那一行会合。
 */
export function layoutWorkbenchGitGraph(
  commits: readonly WorkbenchGitGraphCommit[],
  state: WorkbenchGitGraphState = EmptyWorkbenchGitGraphState
): WorkbenchGitGraphLayout {
  const lanes = [...state.lanes]
  const rows: WorkbenchGitGraphRow[] = []

  for (const commit of commits) {
    // 提交落在最左边那条等着它的线上；没有线在等（分支最新的提交）就占最左边的空列。
    const waiting = lanes.indexOf(commit.sha)
    const lane = waiting >= 0 ? waiting : firstFreeLane(lanes)
    const passing: number[] = []
    const mergingIn: number[] = []
    for (let index = 0; index < lanes.length; index += 1) {
      if (index === lane || lanes[index] === null) continue
      if (lanes[index] === commit.sha) mergingIn.push(index)
      else passing.push(index)
    }
    for (const index of mergingIn) lanes[index] = null

    const branchingOut: number[] = []
    const [mainline, ...others] = commit.parents
    lanes[lane] = mainline ?? null
    if (mainline !== undefined) branchingOut.push(lane)
    for (const parent of others) {
      // 已经有线在等这个父提交：接到那条线上。没有：另占一列——先用提交右边空着的（合并进来的线通常
      // 画在主线右边），右边没有空的就用左边空着的，都占满了才在最右边新开一列。
      let target = lanes.indexOf(parent)
      if (target < 0) {
        const right = firstFreeLane(lanes, lane + 1)
        target = right < lanes.length ? right : firstFreeLane(lanes)
        lanes[target] = parent
      }
      if (!branchingOut.includes(target)) branchingOut.push(target)
    }

    rows.push({
      lane,
      fromAbove: waiting >= 0,
      passing,
      mergingIn,
      branchingOut,
      width: Math.max(lane, ...passing, ...mergingIn, ...branchingOut) + 1,
    })
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop()
  }

  return { rows, state: { lanes } }
}

/**
 * 行高固定的长列表只画视口附近的那些行：视口里的，加上上下各 `overscan` 行。返回要画的行的范围
 * （`end` 不含）。
 */
export function resolveWorkbenchGitLogWindow(input: {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  rowCount: number
  overscan: number
}): { start: number; end: number } {
  const first = Math.floor(Math.max(0, input.scrollTop) / input.rowHeight)
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / input.rowHeight)
  const start = Math.min(Math.max(0, first - input.overscan), input.rowCount)
  return { start, end: Math.min(input.rowCount, first + visible + input.overscan) }
}

/** 提交图最多画这么多条泳道，再往右的不画：同时开着几十条分支的仓库里，图不把提交说明挤没了。 */
export const WorkbenchGitGraphMaxLanes = 14

/** 一段提交图要留多少条泳道的宽度：这些行里用到的最多的，封顶 {@link WorkbenchGitGraphMaxLanes}。 */
export function measureWorkbenchGitGraphLanes(rows: readonly WorkbenchGitGraphRow[]): number {
  let width = 1
  for (const row of rows) {
    if (row.width > width) width = row.width
    if (width >= WorkbenchGitGraphMaxLanes) return WorkbenchGitGraphMaxLanes
  }
  return width
}
