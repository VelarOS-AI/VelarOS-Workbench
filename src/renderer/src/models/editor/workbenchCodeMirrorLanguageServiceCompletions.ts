import {
  type Completion,
  type CompletionContext,
  type CompletionInfo,
  type CompletionResult,
  pickedCompletion,
  snippet,
  startCompletion,
} from '@codemirror/autocomplete'
import {
  type ChangeDesc,
  ChangeSet,
  type EditorState,
  StateEffect,
  StateField,
  type Text,
  Transaction,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import type {
  WorkbenchLanguageServiceCompletionItem,
  WorkbenchLanguageServiceCompletionResolveData,
  WorkbenchLanguageServiceCompletionResolveResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceCompletionTextEdit,
  WorkbenchLanguageServiceRange,
} from '@shared/contracts'

import {
  WORKBENCH_COMPLETION_RETURN_TYPE,
  type WorkbenchCompletionPresentation,
} from './workbenchCodeMirrorCompletionPresentation'
import {
  resolveWorkbenchBuiltinLanguageServiceRuntime,
  usesWorkbenchExternalLspLanguageService,
  usesWorkbenchHtmlLanguageService,
} from './workbenchCodeMirrorLanguageService'
import { convertWorkbenchLspSnippet } from './workbenchLanguageServiceSnippet'

const log = Log.tag('workbench-language-service-completions')
/** 选中的自动导入候选停这么久才去要它的导入语句与说明：方向键一路按下去不必每项都问一遍。 */
const ResolvePreviewDelayMs = 90
const TriggerCharacters = new Set(['.', '@', '/', '<'])
/** 外部语言服务器（如 VelarScript）在这些结构字符后面也给补全：属性名、参数、对象键。 */
const ExternalLspStructuralTriggers = new Set([' ', '{', ',', ':'])

type WorkbenchCompletionResolution = Pick<
  WorkbenchLanguageServiceCompletionResolveResult,
  'additionalTextEdits' | 'documentation'
>

export type WorkbenchCompletionResolver = (
  item: WorkbenchLanguageServiceCompletionResolveData
) => Promise<Nullable<WorkbenchCompletionResolution>>

/** 一次语言服务补全的请求时刻：那时的正文，以及之后正文的全部改动（把请求时算的位置换算到现在）。 */
interface WorkbenchCompletionRequest {
  doc: Text
  path: string
  changes: ChangeDesc
  /** 有一笔改动没接上（不该发生）：之后不再按请求时的位置替换，只换光标前的词。 */
  broken: boolean
  /** 最近一次选中项预取说明的令牌：选中项变了，之前的预取就不必再发。 */
  previewToken: Nullable<object>
  resolve: Nullable<WorkbenchCompletionResolver>
}

interface WorkbenchPreparedCompletion {
  item: WorkbenchLanguageServiceCompletionItem
  request: WorkbenchCompletionRequest
  /** 请求时正文里的替换范围。 */
  range: Nullable<{ from: number; to: number }>
  resolution: Nullable<{
    promise: Promise<Nullable<WorkbenchCompletionResolution>>
    settled: boolean
    value: Nullable<WorkbenchCompletionResolution>
  }>
}

interface WorkbenchOffsetEdit {
  from: number
  to: number
  insert: string
}

function completionWordCharacter(path: string): RegExp {
  const runtime = resolveWorkbenchBuiltinLanguageServiceRuntime(path)
  return runtime === 'css-language-service'
    || runtime === 'html-language-service'
    || runtime === 'markdown-language-service'
    ? /[\p{L}\p{N}_$-]/u
    : /[\p{L}\p{N}_$]/u
}

function completionWordStart(state: EditorState, position: number, character: RegExp): number {
  const line = state.doc.lineAt(position)
  let start = position
  while (start > line.from && character.test(state.sliceDoc(start - 1, start))) start -= 1
  return start
}

/** 这次输入该不该问语言服务：显式唤起、正在输入一个词，或刚敲了触发字符。 */
export function shouldRequestWorkbenchLanguageServiceCompletions(
  context: Pick<CompletionContext, 'explicit' | 'pos' | 'state'>,
  path: string
): boolean {
  if (context.explicit) return true
  if (completionWordStart(context.state, context.pos, completionWordCharacter(path)) < context.pos)
    return true
  const previous = context.state.sliceDoc(context.pos - 1, context.pos)
  return TriggerCharacters.has(previous)
    || (usesWorkbenchExternalLspLanguageService(path) && ExternalLspStructuralTriggers.has(previous))
}

function mapVscodeCompletionItemKind(kind: string | undefined): string | undefined {
  switch (kind) {
    case '2':
      return 'method'
    case '3':
      return 'function'
    case '6':
      return 'variable'
    case '7':
      return 'class'
    case '8':
      return 'interface'
    case '9':
      return 'namespace'
    case '10':
      return 'tag'
    case '12':
      return 'constant'
    case '13':
      return 'enum'
    case '14':
      return 'keyword'
    case '17':
      return 'file'
    case '21':
      return 'constant'
    default:
      return undefined
  }
}

function mapLanguageServiceCompletionType(kind: string | undefined, path: string): string {
  const vscodeKind = mapVscodeCompletionItemKind(kind)
  if (vscodeKind) return vscodeKind

  if (!kind) return usesWorkbenchHtmlLanguageService(path) ? 'tag' : 'text'

  const normalized = kind.toLowerCase()
  if (normalized === 'tag') return 'tag'
  if (
    normalized.includes('keyword') ||
    normalized.includes('scriptelementkind.keyword')
  ) return 'keyword'
  if (normalized.includes('function')) return 'function'
  if (normalized.includes('method')) return 'method'
  if (normalized.includes('class')) return 'class'
  if (normalized.includes('interface')) return 'interface'
  if (normalized.includes('enum')) return 'enum'
  if (normalized.includes('module') || normalized.includes('namespace')) return 'namespace'
  if (normalized.includes('property')) return 'property'
  if (normalized.includes('variable')) return 'variable'
  if (normalized.includes('type')) return 'type'
  if (normalized.includes('constant')) return 'constant'
  return usesWorkbenchHtmlLanguageService(path) ? 'tag' : 'text'
}

function offsetInDocument(doc: Text, line: number, column: number): number {
  if (line > doc.lines) return doc.length
  const lineInfo = doc.line(Math.max(1, line))
  return Math.min(lineInfo.from + Math.max(0, column - 1), lineInfo.to)
}

function rangeInDocument(
  doc: Text,
  range: WorkbenchLanguageServiceRange
): Nullable<{ from: number; to: number }> {
  const from = offsetInDocument(doc, range.startLine, range.startColumn)
  const to = offsetInDocument(doc, range.endLine, range.endColumn)
  return from <= to ? { from, to } : null
}

function trackRequestChanges(request: WorkbenchCompletionRequest, changes: ChangeDesc): void {
  if (request.broken || changes.empty) return
  if (request.changes.newLength !== changes.length) {
    request.broken = true
    return
  }
  request.changes = request.changes.composeDesc(changes)
}

/** 请求时正文 → 当前正文；对不上时返回 null。 */
function currentRequestMapping(request: WorkbenchCompletionRequest, state: EditorState): Nullable<ChangeDesc> {
  return !request.broken && request.changes.newLength === state.doc.length ? request.changes : null
}

/** 请求时正文里的附加改动换算成当前正文的偏移；换算不了、互相重叠的丢掉。 */
function mapAdditionalEdits(
  request: WorkbenchCompletionRequest,
  edits: readonly WorkbenchLanguageServiceCompletionTextEdit[],
  mapping: ChangeDesc
): WorkbenchOffsetEdit[] {
  const mapped = edits
    .filter((edit) => edit.path === request.path)
    .flatMap((edit): WorkbenchOffsetEdit[] => {
      const range = rangeInDocument(request.doc, edit.range)
      if (!range) return []
      const from = mapping.mapPos(range.from, range.from === range.to ? -1 : 1)
      const to = range.from === range.to ? from : mapping.mapPos(range.to, -1)
      return to < from ? [] : [{ from, to, insert: edit.newText }]
    })
    .sort((left, right) => left.from - right.from || left.to - right.to)
  return mapped.filter((edit, index) => index === 0 || edit.from >= mapped[index - 1]!.to)
}

/** 附加改动在补全替换范围之外（紧贴在前面的插入算前面，比如写在文件第一行的 import）。 */
function isOutsideCompletionRange(edit: WorkbenchOffsetEdit, start: number, end: number): boolean {
  if (edit.to <= start) return true
  if (edit.from > end) return true
  return edit.from === end && edit.to > edit.from
}

const trackLateCompletionEdits = StateEffect.define<{ token: object; stop?: boolean }>()

/**
 * 接受补全时还没算出来的自动导入：从接受那一刻起记下正文的所有改动，导入语句算出来后换算到当时的正文再插。
 * 按编辑器状态记：切到别的文件后，这份记录不在那个文件的状态里，迟到的导入也就不会插错文件。
 */
const lateCompletionEditTracker = StateField.define<ReadonlyMap<object, ChangeDesc>>({
  create: () => new Map(),
  update(value, transaction) {
    let next = value
    if (transaction.docChanged && value.size > 0) {
      const mapped = new Map<object, ChangeDesc>()
      for (const [token, changes] of value) mapped.set(token, changes.composeDesc(transaction.changes.desc))
      next = mapped
    }
    for (const effect of transaction.effects) {
      if (!effect.is(trackLateCompletionEdits)) continue
      const updated = new Map(next)
      if (effect.value.stop) updated.delete(effect.value.token)
      else updated.set(effect.value.token, ChangeSet.empty(transaction.newDoc.length).desc)
      next = updated
    }
    return next
  },
})

function startLateEditTracking(state: EditorState, token: object): Array<StateEffect<unknown>> {
  const effects: Array<StateEffect<unknown>> = [trackLateCompletionEdits.of({ token })]
  if (state.field(lateCompletionEditTracker, false) === undefined)
    effects.push(StateEffect.appendConfig.of(lateCompletionEditTracker))
  return effects
}

function applyLateCompletionEdits(
  view: EditorView,
  token: object,
  request: WorkbenchCompletionRequest,
  acceptMapping: ChangeDesc,
  resolution: Nullable<WorkbenchCompletionResolution>
): void {
  const tracked = view.state.field(lateCompletionEditTracker, false)?.get(token)
  if (!tracked) return
  const stop = trackLateCompletionEdits.of({ token, stop: true })
  if (!resolution?.additionalTextEdits.length || acceptMapping.newLength !== tracked.length) {
    view.dispatch({ effects: stop })
    return
  }
  const edits = mapAdditionalEdits(request, resolution.additionalTextEdits, acceptMapping.composeDesc(tracked))
  view.dispatch({
    changes: edits,
    effects: stop,
    annotations: Transaction.userEvent.of('input.complete'),
  })
}

function ensureCompletionResolution(
  prepared: WorkbenchPreparedCompletion
): Promise<Nullable<WorkbenchCompletionResolution>> {
  const resolveData = prepared.item.resolve
  const resolve = prepared.request.resolve
  if (!resolveData || !resolve) return Promise.resolve(null)
  if (prepared.resolution) return prepared.resolution.promise

  const entry: NonNullable<WorkbenchPreparedCompletion['resolution']> = {
    promise: Promise.resolve(null),
    settled: false,
    value: null,
  }
  entry.promise = resolve(resolveData).then(
    (value) => {
      entry.settled = true
      entry.value = value
      return value
    },
    (error: unknown) => {
      // 没要到（worker 重启、请求被取消）：下次选中或接受时再要。
      if (prepared.resolution === entry) prepared.resolution = null
      log.debug('failed to resolve completion item', { label: prepared.item.label, error })
      return null
    }
  )
  prepared.resolution = entry
  return entry.promise
}

function textCompletionInfo(text: string | undefined): CompletionInfo {
  return text ? document.createTextNode(text) : null
}

async function previewCompletionInfo(prepared: WorkbenchPreparedCompletion): Promise<CompletionInfo> {
  const token = {}
  prepared.request.previewToken = token
  if (!prepared.resolution) {
    await new Promise((resolve) => setTimeout(resolve, ResolvePreviewDelayMs))
    if (prepared.request.previewToken !== token) return null
  }
  const resolution = await ensureCompletionResolution(prepared)
  return textCompletionInfo(resolution?.documentation ?? prepared.item.documentation)
}

/**
 * 接受一个语言服务补全：按它自己的替换范围（可选链换掉 `.`，import 语句补全换掉整句开头）写入，片段展开成可按 Tab
 * 跳转的占位符，自动导入这类附加改动与正文在同一笔改动里完成、一步撤销。附加改动要现算的（TypeScript 自动导入还没
 * 预取到）先写正文，导入语句算出来后再补上。
 */
function applyWorkbenchLanguageServiceCompletion(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  prepared: WorkbenchPreparedCompletion
): void {
  const { item, request } = prepared
  const state = view.state
  const mapping = currentRequestMapping(request, state)

  let start = from
  let end = to
  if (prepared.range && mapping) {
    start = Math.min(from, mapping.mapPos(prepared.range.from, -1))
    end = Math.max(to, mapping.mapPos(prepared.range.to, 1))
  }

  const resolved = prepared.resolution?.settled ? prepared.resolution.value : null
  const pendingResolve = !!item.resolve && !!request.resolve && !prepared.resolution?.settled
  const extraEdits = mapping
    ? mapAdditionalEdits(
        request,
        [...(item.additionalTextEdits ?? []), ...(resolved?.additionalTextEdits ?? [])],
        mapping
      ).filter((edit) => isOutsideCompletionRange(edit, start, end))
    : []
  const lateToken = pendingResolve && mapping ? {} : null
  const effects = lateToken ? startLateEditTracking(state, lateToken) : []
  const annotations = [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')]
  const insert = item.insertText ?? item.label
  const converted = item.isSnippet ? convertWorkbenchLspSnippet(insert) : null

  let acceptChanges: ChangeSet
  if (converted?.hasTabStops) {
    const extraChanges = state.changes(extraEdits)
    const intermediate = state.update({ changes: extraChanges }).state
    const snippetStart = extraChanges.mapPos(start, 1)
    const snippetEnd = Math.max(snippetStart, extraChanges.mapPos(end, -1))
    let captured: Nullable<Transaction> = null
    snippet(converted.template)(
      { state: intermediate, dispatch: (transaction) => { captured = transaction } },
      completion,
      snippetStart,
      snippetEnd
    )
    const snippetTransaction = captured as Nullable<Transaction>
    if (!snippetTransaction) return
    acceptChanges = extraChanges.compose(snippetTransaction.changes)
    view.dispatch({
      changes: acceptChanges,
      selection: snippetTransaction.selection,
      effects: [...snippetTransaction.effects, ...effects],
      annotations,
      scrollIntoView: true,
    })
  } else {
    const text = converted ? converted.text : insert
    acceptChanges = state.changes([
      ...extraEdits.filter((edit) => edit.to <= start),
      { from: start, to: end, insert: text },
      ...extraEdits.filter((edit) => edit.to > start),
    ])
    view.dispatch({
      changes: acceptChanges,
      selection: { anchor: acceptChanges.mapPos(end, 1) },
      effects,
      annotations,
      scrollIntoView: true,
    })
  }

  if (lateToken && mapping) {
    const acceptMapping = mapping.composeDesc(acceptChanges.desc)
    void ensureCompletionResolution(prepared).then((resolution) =>
      applyLateCompletionEdits(view, lateToken, request, acceptMapping, resolution)
    )
  }
  if (item.retrigger) startCompletion(view)
}

function createWorkbenchCompletionRequest(
  state: EditorState,
  path: string,
  resolve: Nullable<WorkbenchCompletionResolver>
): WorkbenchCompletionRequest {
  return {
    doc: state.doc,
    path,
    changes: ChangeSet.empty(state.doc.length).desc,
    broken: false,
    previewToken: null,
    resolve,
  }
}

function toCodeMirrorCompletion(
  item: WorkbenchLanguageServiceCompletionItem,
  request: WorkbenchCompletionRequest,
  wordStart: number
): WorkbenchCompletionPresentation {
  const type = mapLanguageServiceCompletionType(item.kind, request.path)
  const range = item.range ? rangeInDocument(request.doc, item.range) : null
  // CodeMirror 拿 label 与光标前的词比对：替换范围从词首之前开始（`.`、`@`、`&`）时，比对文字去掉那一截。
  let label = item.filterText || item.label
  if (range && range.from < wordStart) {
    const leading = request.doc.sliceString(range.from, wordStart)
    if (label.startsWith(leading) && label.length > leading.length) label = label.slice(leading.length)
  }
  const insert = item.insertText ?? item.label
  const prepared: WorkbenchPreparedCompletion = { item, request, range, resolution: null }
  const plain = !range && !item.isSnippet && !item.additionalTextEdits?.length && !item.resolve && !item.retrigger

  return {
    label,
    displayLabel: optionalWhen(label !== item.label, item.label),
    type,
    detail: item.detail,
    [WORKBENCH_COMPLETION_RETURN_TYPE]: item.returnType,
    sortText: item.sortText,
    info: item.resolve
      ? () => previewCompletionInfo(prepared)
      : type === 'keyword' ? undefined : item.documentation,
    apply: plain
      ? insert
      : (view, completion, from, to) =>
          applyWorkbenchLanguageServiceCompletion(view, completion, from, to, prepared),
  }
}

/** 按给定的编辑器状态单独换算一项候选（列表之外检查一项的比对文字、显示文字与写法）。 */
export function mapWorkbenchLanguageServiceCompletionToCodeMirror({
  state,
  path,
  item,
}: {
  state: EditorState
  path: string
  item: WorkbenchLanguageServiceCompletionItem
}): Completion {
  const request = createWorkbenchCompletionRequest(state, path, null)
  const position = state.selection.main.head
  return toCodeMirrorCompletion(item, request, completionWordStart(state, position, completionWordCharacter(path)))
}

/**
 * 语言服务返回的整份候选交给 CodeMirror 自己筛选、排序（不在服务端按前缀截断，`document.` 后面的上百个成员都在）。
 * 列表完整时，继续输入同一个词直接在这份里筛；列表不完整或词变短了才重新请求。
 */
export function buildWorkbenchLanguageServiceCompletionResult({
  state,
  position,
  path,
  result,
  localResult = null,
  resolve = null,
}: {
  state: EditorState
  position: number
  path: string
  result: Pick<WorkbenchLanguageServiceCompletionResult, 'items' | 'isIncomplete'>
  localResult?: Nullable<CompletionResult>
  resolve?: Nullable<WorkbenchCompletionResolver>
}): Nullable<CompletionResult> {
  const character = completionWordCharacter(path)
  const from = completionWordStart(state, position, character)
  const typed = state.sliceDoc(from, position)
  const request = createWorkbenchCompletionRequest(state, path, resolve)

  const seen = new Set<string>()
  const options: Completion[] = result.items.map((item) => {
    const option = toCodeMirrorCompletion(item, request, from)
    seen.add(option.label.toLowerCase())
    return option
  })
  // 本地索引的候选与语言服务的共用同一个替换起点才合进来（HTML 的本地候选不合）。
  if (localResult?.from === from && !usesWorkbenchHtmlLanguageService(path)) {
    for (const option of localResult.options) {
      const key = option.label.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      options.push(option)
    }
  }
  if (options.length === 0) return null

  const word = new RegExp(`^${character.source}*$`, 'u')
  return {
    from,
    to: position,
    options,
    validFor: result.isIncomplete
      ? undefined
      : (text: string) => text.startsWith(typed) && word.test(text),
    map: (current, changes) => {
      trackRequestChanges(request, changes)
      return current
    },
  }
}

/** 语言服务补全源的异步部分：候选回来前不先亮本地列表，免得同一个列表闪两次。 */
export async function requestWorkbenchLanguageServiceCompletions({
  state,
  position,
  path,
  localResult,
  request,
  resolve,
}: {
  state: EditorState
  position: number
  path: string
  localResult: Nullable<CompletionResult>
  request: () => Promise<Result<WorkbenchLanguageServiceCompletionResult>>
  resolve: (
    item: WorkbenchLanguageServiceCompletionResolveData
  ) => Promise<Result<WorkbenchLanguageServiceCompletionResolveResult>>
}): Promise<Nullable<CompletionResult>> {
  let response: Result<WorkbenchLanguageServiceCompletionResult>
  try {
    response = await request()
  } catch (error) {
    log.debug('language service completion failed', { path, error })
    return localResult
  }
  // 被同一文件更新的补全请求顶掉了：那一次的结果会接上，这里不再先亮本地候选。
  if (!response.ok) return response.error.code === 'CANCELLED' ? null : localResult
  if (response.data.items.length === 0) return localResult

  return buildWorkbenchLanguageServiceCompletionResult({
    state,
    position,
    path,
    result: response.data,
    localResult,
    resolve: async (item) => {
      const resolved = await resolve(item)
      // 没要到（worker 在重启、请求超时）按失败处理：下次选中或接受时再要，不把「没有导入」记下来。
      if (!resolved.ok) throw new AppError(resolved.error.code, resolved.error.message)
      return resolved.data
    },
  }) ?? localResult
}
