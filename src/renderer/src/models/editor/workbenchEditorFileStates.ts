// 只用 CodeMirror 的类型：编辑区外壳（EditorPanel）持有这份记录，不能因此把懒加载的编辑器依赖拉进首屏。
import type { EditorState, StateEffect } from '@codemirror/state'

/** 切走的文件留下的编辑器状态：正文、撤销历史、选区、折叠，外加滚动位置。 */
export interface WorkbenchEditorFileState {
  state: EditorState
  /** `EditorView.scrollSnapshot()`：换回来时滚回原处。 */
  scroll: StateEffect<unknown>
  /** 当前行高亮还处在「刚打开、没动过」的暂隐状态。 */
  activeLineSuppressed: boolean
  /**
   * 建出这份状态的编辑器实例。同一个实例直接把状态换回去；换了实例（编辑器因预览、对比视图卸载后重新挂载，
   * 或者标签挪到了另一组的编辑器里）旧状态里的扩展属于别的实例，只取能序列化的部分重建。
   */
  owner: object
}

/** 正在显示某个文件的编辑器：另一个编辑器要接手这个文件时，向它要此刻的状态。 */
export interface WorkbenchEditorFileStateHolder {
  /** 编辑器实例（与它存下的状态的 `owner` 是同一个对象）。 */
  owner: object
  /** 此刻的状态；视图已经不在了给 null。 */
  snapshot: () => Nullable<WorkbenchEditorFileState>
}

/** 最多记这么多个文件，超出后先丢最久没看的。 */
const MaxFileStates = 64

export function workbenchEditorFileStateKey(projectRoot: string, path: string): string {
  return `${projectRoot}\0${path}`
}

/**
 * 按文件记着的编辑器状态。一个编辑器只有一个视图，切标签时把离开的文件存进来、把要显示的取出来，撤销历史、
 * 光标、折叠、滚动位置各归各的文件——⌘Z 撤不到别的文件的内容上。正在显示的文件不在这里（取出时就移除了）。
 *
 * 编辑区拆成左右两组时两个编辑器共用这一份：一个文件同一时刻只在一组里显示。标签从一组挪到另一组，接手的
 * 编辑器可能先于原来那个换文件（React 按组件顺序跑副作用）；所以取状态时登记「谁在显示它」，接手的那个直接向
 * 还在显示它的编辑器要此刻的状态，原来那个随后存进来的旧状态不收。
 */
export class WorkbenchEditorFileStates {
  private readonly states = new Map<string, WorkbenchEditorFileState>()
  private readonly holders = new Map<string, WorkbenchEditorFileStateHolder>()

  /**
   * 取出并移除这个文件的状态。给了 `holder`（取的那个编辑器接下来显示这个文件）就登记下来；文件此刻还在
   * 另一个编辑器里显示着时，给的是那个编辑器此刻的状态。
   */
  public take(key: string, holder?: WorkbenchEditorFileStateHolder): WorkbenchEditorFileState | undefined {
    const current = this.holders.get(key)
    const saved = this.states.get(key)
    this.states.delete(key)
    if (holder) this.holders.set(key, holder)
    if (current && current.owner !== holder?.owner) return current.snapshot() ?? saved
    return saved
  }

  public save(key: string, saved: WorkbenchEditorFileState): void {
    // 这个文件已经由另一个编辑器接手显示了：它手里的才是最新的，这一份不收。
    const holder = this.holders.get(key)
    if (holder && holder.owner !== saved.owner) return
    this.holders.delete(key)

    // 重新插入，让 Map 的顺序就是最近使用的顺序。
    this.states.delete(key)
    this.states.set(key, saved)
    while (this.states.size > MaxFileStates) {
      const oldest = this.states.keys().next().value
      if (oldest === undefined) break
      this.states.delete(oldest)
    }
  }

  /** 只留下这些文件：标签关掉，它的撤销历史也跟着丢。 */
  public retain(keys: Iterable<string>): void {
    const open = new Set(keys)
    for (const key of [...this.states.keys()]) if (!open.has(key)) this.states.delete(key)
  }

  public get size(): number {
    return this.states.size
  }
}
