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
   * 建出这份状态的编辑器实例。同一个实例直接把状态换回去；换了实例（编辑器因预览、对比视图卸载后重新挂载）
   * 旧状态里的扩展属于已经销毁的实例，只取能序列化的部分重建。
   */
  owner: object
}

/** 最多记这么多个文件，超出后先丢最久没看的。 */
const MaxFileStates = 64

export function workbenchEditorFileStateKey(projectRoot: string, path: string): string {
  return `${projectRoot}\0${path}`
}

/**
 * 按文件记着的编辑器状态。编辑器只有一个视图，切标签时把离开的文件存进来、把要显示的取出来，撤销历史、光标、
 * 折叠、滚动位置各归各的文件——⌘Z 撤不到别的文件的内容上。正在显示的文件不在这里（取出时就移除了）。
 */
export class WorkbenchEditorFileStates {
  private readonly states = new Map<string, WorkbenchEditorFileState>()

  /** 取出并移除这个文件的状态。 */
  public take(key: string): WorkbenchEditorFileState | undefined {
    const saved = this.states.get(key)
    this.states.delete(key)
    return saved
  }

  public save(key: string, saved: WorkbenchEditorFileState): void {
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
