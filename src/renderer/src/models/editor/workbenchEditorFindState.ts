// 只有类型和常量、不引 CodeMirror：编辑区外壳（EditorPanel）持有查找栏状态，不能因此把懒加载的编辑器依赖拉进首屏。

/** 查找栏的开关项。 */
export interface WorkbenchEditorFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  /** 只在打开这一项那一刻的选区里找。 */
  inSelection: boolean
}

/** 查找栏交给编辑器的一次查找：查找词、替换文本与开关项。 */
export interface WorkbenchEditorFindRequest extends WorkbenchEditorFindOptions {
  query: string
  replace: string
}

/** 报回查找栏的结果：共几处；当前选中的是第几处（从 1 起，没选中任何一处为 0）。 */
export interface WorkbenchEditorFindStatus {
  total: number
  current: number
  /** 匹配太多，只数到了上限。 */
  limited: boolean
  /** 正则写得不对。 */
  invalid: boolean
}

export const EmptyWorkbenchEditorFindStatus: WorkbenchEditorFindStatus = {
  total: 0,
  current: 0,
  limited: false,
  invalid: false,
}

export const DefaultWorkbenchEditorFindOptions: WorkbenchEditorFindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  inSelection: false,
}
