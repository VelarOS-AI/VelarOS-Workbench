/** 导航历史里的一个位置：文件和光标，以及当时在编辑区的哪一组（0 左，1 右）。 */
export interface WorkbenchNavigationPoint {
  path: string
  line: number
  column: number
  /** 回到这个位置时，文件的标签已经关掉了就在这一组里重新打开。 */
  group?: number
}

/** 最多记这么多步，再往前的丢掉。 */
const MaxNavigationPoints = 50

/** 同一个文件的同一行算同一个位置：后退不会停在只差几列的地方。 */
function sameNavigationPoint(left: WorkbenchNavigationPoint, right: WorkbenchNavigationPoint): boolean {
  return left.path === right.path && left.line === right.line
}

/**
 * 编辑区的后退 / 前进（VS Code 的 Go Back / Go Forward）：切文件、跳到定义、跳到行之前记下当前位置，后退回到那里，
 * 前进再回来。新跳一次，前进的那些就作废。
 */
export class WorkbenchNavigationHistory {
  private backPoints: WorkbenchNavigationPoint[] = []
  private forwardPoints: WorkbenchNavigationPoint[] = []

  /** 要跳走了：记下现在的位置。 */
  public record(current: Nullable<WorkbenchNavigationPoint>): void {
    this.forwardPoints = []
    if (!current) return
    const last = this.backPoints.at(-1)
    if (last && sameNavigationPoint(last, current)) return
    this.backPoints.push(current)
    if (this.backPoints.length > MaxNavigationPoints) this.backPoints.shift()
  }

  /** 后退：给出要回到的位置（跳过就在当前位置的记录），当前位置留给前进；没得退时为 null。 */
  public back(current: Nullable<WorkbenchNavigationPoint>): Nullable<WorkbenchNavigationPoint> {
    return this.step(this.backPoints, this.forwardPoints, current)
  }

  public forward(current: Nullable<WorkbenchNavigationPoint>): Nullable<WorkbenchNavigationPoint> {
    return this.step(this.forwardPoints, this.backPoints, current)
  }

  private step(
    from: WorkbenchNavigationPoint[],
    to: WorkbenchNavigationPoint[],
    current: Nullable<WorkbenchNavigationPoint>
  ): Nullable<WorkbenchNavigationPoint> {
    let target = from.pop()
    while (target && current && sameNavigationPoint(target, current)) target = from.pop()
    if (!target) return null
    if (current) to.push(current)
    return target
  }
}
