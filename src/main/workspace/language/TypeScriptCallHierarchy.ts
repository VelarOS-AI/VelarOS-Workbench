import type * as ts from 'typescript'

import { type WorkbenchLanguageServiceCallHierarchyCall, type WorkbenchLanguageServiceCallHierarchyDirection, type WorkbenchLanguageServiceCallHierarchyItem, type WorkbenchLanguageServiceLocation } from '@shared/contracts/workbench'

import { mapTypeScriptSymbolKind, rangeFromTextSpanInContent } from './TypeScriptLanguageFeatures'

/** 调用处那一行的预览最多这么长（与引用列表一致）。 */
const MaxCallSitePreviewLength = 200

export interface TypeScriptCallHierarchyContext {
  service: ts.LanguageService
  fileName: string
  /** 光标在请求文件里的偏移。 */
  offset: number
  /** 一个文件此刻的正文（项目里记着的，没有就读盘）；读不到为 null。 */
  readFile: (fileName: string) => Nullable<string>
  /** 项目内相对路径；项目之外的文件（TypeScript 自带的标准库……）为 null。 */
  toRelativePath: (fileName: string) => Nullable<string>
}

function firstItem(
  prepared: ts.CallHierarchyItem | ts.CallHierarchyItem[] | undefined
): ts.CallHierarchyItem | undefined {
  return Array.isArray(prepared) ? prepared[0] : prepared
}

function toItem(
  context: TypeScriptCallHierarchyContext,
  item: ts.CallHierarchyItem
): Nullable<WorkbenchLanguageServiceCallHierarchyItem> {
  const path = context.toRelativePath(item.file)
  const content = context.readFile(item.file)
  if (!path || content == null) return null
  const range = rangeFromTextSpanInContent(content, item.file, item.selectionSpan)
  if (!range) return null

  return {
    // 写在文件最外层的调用，TypeScript 拿整个文件当调用方，名字给的是绝对路径：只留文件名。
    name: item.name === item.file ? path.slice(path.lastIndexOf('/') + 1) : item.name,
    kind: mapTypeScriptSymbolKind(item.kind),
    containerName: item.containerName || undefined,
    path,
    line: range.startLine,
    column: range.startColumn,
  }
}

/** 调用发生的那些地方（都在 `fileName` 这个文件里），各带那一行的文字，按先后排。 */
function toSites(
  context: TypeScriptCallHierarchyContext,
  fileName: string,
  spans: readonly ts.TextSpan[]
): WorkbenchLanguageServiceLocation[] {
  const path = context.toRelativePath(fileName)
  const content = context.readFile(fileName)
  if (!path || content == null) return []

  const lines = content.split('\n')
  const seen = new Set<number>()
  return [...spans]
    .sort((left, right) => left.start - right.start)
    .flatMap((span) => {
      // 同一处 TypeScript 有时给两遍。
      if (seen.has(span.start)) return []
      seen.add(span.start)
      const range = rangeFromTextSpanInContent(content, fileName, span)
      if (!range) return []
      return [
        {
          path,
          line: range.startLine,
          column: range.startColumn,
          range,
          preview: (lines[range.startLine - 1] ?? '').trim().slice(0, MaxCallSitePreviewLength),
        },
      ]
    })
}

/**
 * 光标处的函数（方法、构造函数、类……）以及它的一层调用关系：谁调用它（`incoming`），或者它调用谁
 * （`outgoing`）。再往下一层由界面拿某个调用方 / 被调用方名字的位置再问一次，一层一层展开。
 *
 * 光标停在调用处时，TypeScript 认的是被调用的那个声明：结果里的 `item` 在声明那里，可能在另一个文件。
 * 调用方、被调用方在项目之外的（标准库里的函数）不列：跳不过去，也没法再往下问。
 */
export function buildTypeScriptCallHierarchy(
  context: TypeScriptCallHierarchyContext,
  direction: WorkbenchLanguageServiceCallHierarchyDirection
): { item: Nullable<WorkbenchLanguageServiceCallHierarchyItem>; calls: WorkbenchLanguageServiceCallHierarchyCall[] } {
  const { service } = context
  const prepared = firstItem(service.prepareCallHierarchy(context.fileName, context.offset))
  const item = prepared ? toItem(context, prepared) : null
  if (!prepared || !item) return { item: null, calls: [] }

  const declarationOffset = prepared.selectionSpan.start
  const calls: WorkbenchLanguageServiceCallHierarchyCall[] = []
  if (direction === 'incoming') {
    for (const call of service.provideCallHierarchyIncomingCalls(prepared.file, declarationOffset)) {
      const caller = toItem(context, call.from)
      // 调用处在调用方自己的文件里。
      if (caller) calls.push({ item: caller, sites: toSites(context, call.from.file, call.fromSpans) })
    }
  } else {
    for (const call of service.provideCallHierarchyOutgoingCalls(prepared.file, declarationOffset)) {
      const callee = toItem(context, call.to)
      // 调用处在被问的这个函数的文件里。
      if (callee) calls.push({ item: callee, sites: toSites(context, prepared.file, call.fromSpans) })
    }
  }

  // 调用方按所在的文件、位置排；被调用方按在函数体里出现的先后排。
  const order = (call: WorkbenchLanguageServiceCallHierarchyCall): [string, number, number] =>
    direction === 'incoming'
      ? [call.item.path, call.item.line, call.item.column]
      : ['', call.sites[0]?.line ?? 0, call.sites[0]?.column ?? 0]
  calls.sort((left, right) => {
    const [leftPath, leftLine, leftColumn] = order(left)
    const [rightPath, rightLine, rightColumn] = order(right)
    return leftPath.localeCompare(rightPath) || leftLine - rightLine || leftColumn - rightColumn
  })
  return { item, calls }
}
