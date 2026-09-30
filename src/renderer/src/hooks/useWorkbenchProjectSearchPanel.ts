/**
 * 项目搜索面板（侧栏的搜索，⇧⌘F）的开关与表单：开没开、查找词之外的开关、替换文字、包含 / 排除的文件。
 *
 * 这些跟着页面走（切到别的左侧面板再回来都还在）；搜索与替换本身在面板里（`ProjectSearchView`，打开搜索时
 * 才加载），查找词与按文件名找共用输入框，由 useWorkbenchSearchController 管着。
 */
import { useState } from 'react'

import {
  escapeWorkbenchTextSearchRegExp,
  resolveWorkbenchTextOffset,
} from '@shared/workbenchSearchText'
// 只要类型：匹配规则本身随搜索面板按需加载，不进工作区外壳。
import type { WorkbenchTextSearchOptions } from '@shared/workbenchTextSearch'

import { useMemoizedFn } from '../support/genericHooks'

/** 拿选中的文字当查找词时最长取这么多字符（与编辑器查找栏一致）。 */
const MaxSeedChars = 200

interface UseWorkbenchProjectSearchPanelOptions {
  onQueryChange: (query: string) => void
  /** 收起搜索：清掉查找词，文件树回来。 */
  onResetQuery: () => void
}

/**
 * ⇧⌘F 预填的查找词：编辑器里选中了一行以内的文字就用它（最长 200 个字符）；没选中或跨了行不预填。
 * 选区的行列从 1 起，按编辑器里的正文算。
 */
export function readWorkbenchProjectSearchSeed(
  content: string,
  selection: LooseOptional<{ startLine: number; startColumn: number; endLine: number; endColumn: number }>
): string | undefined {
  if (!selection || selection.startLine !== selection.endLine) return undefined

  const from = resolveWorkbenchTextOffset(content, selection.startLine, selection.startColumn)
  const to = resolveWorkbenchTextOffset(content, selection.endLine, selection.endColumn)
  return content.slice(from, Math.min(to, from + MaxSeedChars)) || undefined
}

export function useWorkbenchProjectSearchPanel(options: UseWorkbenchProjectSearchPanelOptions) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusPending, setFocusPending] = useState(false)
  const [searchOptions, setSearchOptions] = useState<WorkbenchTextSearchOptions>({
    matchCase: false,
    wholeWord: false,
    regex: false,
  })
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')

  /** 打开搜索（⇧⌘F、放大镜、右键菜单）：给了 seed 就拿它当查找词（正则模式下按字面转义）。 */
  const openPanel = useMemoizedFn((seed?: string): void => {
    if (seed) options.onQueryChange(searchOptions.regex ? escapeWorkbenchTextSearchRegExp(seed) : seed)
    setIsOpen(true)
    setFocusPending(true)
  })

  const closePanel = useMemoizedFn((): void => {
    setIsOpen(false)
    setFocusPending(false)
    options.onResetQuery()
  })

  return {
    isOpen,
    /** 刚打开（或再按了一次 ⇧⌘F）：查找框要拿到焦点并全选。 */
    focusPending,
    acknowledgeFocus: useMemoizedFn((): void => setFocusPending(false)),
    openPanel,
    closePanel,
    togglePanel: useMemoizedFn((): void => (isOpen ? closePanel() : openPanel())),
    options: searchOptions,
    toggleOption: useMemoizedFn((option: keyof WorkbenchTextSearchOptions): void => {
      setSearchOptions((current) => ({ ...current, [option]: !current[option] }))
    }),
    replaceOpen,
    toggleReplace: useMemoizedFn((): void => setReplaceOpen((open) => !open)),
    replacement,
    setReplacement,
    detailsOpen,
    toggleDetails: useMemoizedFn((): void => setDetailsOpen((open) => !open)),
    include,
    setInclude,
    exclude,
    setExclude,
  }
}

export type WorkbenchProjectSearchPanelModel = ReturnType<typeof useWorkbenchProjectSearchPanel>
