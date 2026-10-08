import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import type { ReasoningLevel } from '@velaros-ai/ui/conversation/contracts'
import { type BrowserElementSelection } from '@velaros-ai/velaros/browser/contracts'

import { appendWorkbenchChatFileReferences } from '../models/chat/workbenchChatFileReferences'

/** 发送、入队和放回输入框都携带同一份代码上下文与执行选项。 */
export interface WorkbenchComposerContext {
  browserSelections: BrowserElementSelection[]
  selectedFileReferencePaths: string[]
  includedCurrentFilePath: Nullable<string>
  goalMode: boolean
  planMode: boolean
  reasoningLevel: ReasoningLevel
}

interface StandaloneChatDraft {
  value: string
  files: File[]
  context?: WorkbenchComposerContext
  fileReferencePaths?: string[]
  observedCurrentFilePath?: Nullable<string>
}

type Update<T> = T | ((previous: T) => T)

export const EmptyWorkbenchComposerContext: WorkbenchComposerContext = {
  browserSelections: [],
  selectedFileReferencePaths: [],
  includedCurrentFilePath: null,
  goalMode: false,
  planMode: false,
  reasoningLevel: 'medium',
}

/** 入队时复制可变集合，后续编辑与页面拾取不会改变已经排队的内容。 */
export function snapshotWorkbenchComposerContext(
  context: WorkbenchComposerContext
): WorkbenchComposerContext {
  return {
    ...context,
    browserSelections: structuredClone(context.browserSelections),
    selectedFileReferencePaths: [...context.selectedFileReferencePaths],
  }
}

const drafts = new Map<string, StandaloneChatDraft>()
const listeners = new Map<string, Set<() => void>>()
const EmptyDraft: StandaloneChatDraft = { value: '', files: [] }

/** 草稿跟随项目和会话；异步发送的回调始终修改发起会话的那份。 */
export function readStandaloneChatDraft(scope: string): StandaloneChatDraft {
  return drafts.get(scope) ?? EmptyDraft
}

export function updateStandaloneChatDraft(
  scope: string,
  update: (current: StandaloneChatDraft) => StandaloneChatDraft
): void {
  const next = update(readStandaloneChatDraft(scope))
  if (!next.value && next.files.length === 0 && !next.context && !next.fileReferencePaths?.length)
    drafts.delete(scope)
  else drafts.set(scope, next)
  for (const listener of listeners.get(scope) ?? []) listener()
}

export function forgetStandaloneChatDraft(scope: string): void {
  drafts.delete(scope)
  for (const listener of listeners.get(scope) ?? []) listener()
}

/** 编辑器或浏览器异步投递的上下文始终进发起会话，并与已有草稿合并。 */
export function appendStandaloneChatContext(
  scope: string,
  input: { browserSelections?: readonly BrowserElementSelection[]; filePaths?: readonly string[] }
): void {
  updateStandaloneChatDraft(scope, (current) => {
    const context = current.context ?? EmptyWorkbenchComposerContext
    return {
      ...current,
      fileReferencePaths: appendWorkbenchChatFileReferences(
        current.fileReferencePaths ?? [],
        input.filePaths ?? []
      ),
      context: {
        ...context,
        selectedFileReferencePaths: appendWorkbenchChatFileReferences(
          context.selectedFileReferencePaths,
          input.filePaths ?? []
        ),
        browserSelections: [
          ...context.browserSelections,
          ...structuredClone(input.browserSelections ?? []).filter(
            (selection) => !context.browserSelections.some((current) => current.id === selection.id)
          ),
        ],
      },
    }
  })
}

/** 只收走已提交的内容，读取附件或登录期间新写的草稿继续保留。 */
export function consumeStandaloneChatDraft(
  scope: string,
  submitted: { value: string; files: readonly File[]; context: WorkbenchComposerContext }
): void {
  updateStandaloneChatDraft(scope, (current) => ({
    ...current,
    value: current.value.trim() === submitted.value.trim() ? '' : current.value,
    files: current.files.filter((file) => !submitted.files.includes(file)),
    context: current.context
      ? {
          ...current.context,
          browserSelections: current.context.browserSelections.filter(
            (selection) =>
              !submitted.context.browserSelections.some((sent) => sent.id === selection.id)
          ),
          selectedFileReferencePaths: current.context.selectedFileReferencePaths.filter(
            (path) => !submitted.context.selectedFileReferencePaths.includes(path)
          ),
        }
      : undefined,
  }))
}

export function useStandaloneChatDraft(
  scope: string,
  defaults: {
    currentFilePath: Nullable<string>
    reasoningLevel: ReasoningLevel
  }
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const scoped = listeners.get(scope) ?? new Set<() => void>()
      listeners.set(scope, scoped)
      scoped.add(listener)
      return () => {
        scoped.delete(listener)
        if (!scoped.size) listeners.delete(scope)
      }
    },
    [scope]
  )
  const draft = useSyncExternalStore(subscribe, () => readStandaloneChatDraft(scope))
  const defaultContext = useMemo(
    () => ({
      ...EmptyWorkbenchComposerContext,
      includedCurrentFilePath: defaults.currentFilePath,
      reasoningLevel: defaults.reasoningLevel,
    }),
    [defaults.currentFilePath, defaults.reasoningLevel]
  )
  const context = draft.context ?? defaultContext
  const setContext = useCallback(
    (next: Update<WorkbenchComposerContext>) => {
      updateStandaloneChatDraft(scope, (current) => ({
        ...current,
        context: typeof next === 'function' ? next(current.context ?? defaultContext) : next,
        observedCurrentFilePath: current.observedCurrentFilePath ?? defaults.currentFilePath,
      }))
    },
    [scope, defaultContext, defaults.currentFilePath]
  )
  useEffect(() => {
    const current = readStandaloneChatDraft(scope)
    if (current.context && current.observedCurrentFilePath === defaults.currentFilePath) return
    updateStandaloneChatDraft(scope, (current) => ({
      ...current,
      observedCurrentFilePath: defaults.currentFilePath,
      context: {
        ...(current.context ?? defaultContext),
        includedCurrentFilePath: defaults.currentFilePath,
      },
    }))
  }, [scope, defaults.currentFilePath, defaultContext])
  const setContextField = useCallback(
    <K extends keyof WorkbenchComposerContext>(
      key: K,
      next: Update<WorkbenchComposerContext[K]>
    ) => {
      setContext((current) => ({
        ...current,
        [key]: typeof next === 'function' ? next(current[key]) : next,
      }))
    },
    [setContext]
  )
  const contextSetters = useMemo(
    () => ({
      setBrowserSelections: (next: Update<BrowserElementSelection[]>) =>
        setContextField('browserSelections', next),
      setSelectedFileReferencePaths: (next: Update<string[]>) =>
        setContextField('selectedFileReferencePaths', next),
      setIncludedCurrentFilePath: (next: Update<Nullable<string>>) =>
        setContextField('includedCurrentFilePath', next),
      setGoalMode: (next: Update<boolean>) => setContextField('goalMode', next),
      setPlanMode: (next: Update<boolean>) => setContextField('planMode', next),
      setReasoningLevel: (next: Update<ReasoningLevel>) => setContextField('reasoningLevel', next),
    }),
    [setContextField]
  )
  const setFileReferencePaths = useCallback(
    (next: Update<string[]>) => {
      updateStandaloneChatDraft(scope, (current) => ({
        ...current,
        fileReferencePaths:
          typeof next === 'function' ? next(current.fileReferencePaths ?? []) : next,
      }))
    },
    [scope]
  )
  const setValue = useCallback(
    (next: string | ((previous: string) => string)) => {
      updateStandaloneChatDraft(scope, (current) => ({
        ...current,
        value: typeof next === 'function' ? next(current.value) : next,
      }))
    },
    [scope]
  )
  const setFiles = useCallback(
    (next: File[] | ((previous: File[]) => File[])) => {
      updateStandaloneChatDraft(scope, (current) => ({
        ...current,
        files: typeof next === 'function' ? next(current.files) : next,
      }))
    },
    [scope]
  )
  return {
    ...draft,
    ...context,
    context,
    fileReferencePaths:
      draft.fileReferencePaths ?? EmptyWorkbenchComposerContext.selectedFileReferencePaths,
    setContext,
    setFileReferencePaths,
    ...contextSetters,
    setValue,
    setFiles,
  }
}
