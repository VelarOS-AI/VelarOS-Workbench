import type {
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceTextEdit,
} from '@shared/contracts'

import {
  mapTypeScriptFileChanges,
  type TypeScriptEditContext,
  typeScriptWriteSettings,
} from './TypeScriptCodeActions'

/** 一个文件或目录的改名 / 移动，绝对路径。请求到来时磁盘上已经是新位置。 */
export interface TypeScriptFileRename {
  previousFileName: string
  fileName: string
}

function rangesOverlap(left: WorkbenchLanguageServiceRange, right: WorkbenchLanguageServiceRange): boolean {
  const startsBeforeEnd = (a: WorkbenchLanguageServiceRange, b: WorkbenchLanguageServiceRange): boolean =>
    a.startLine < b.endLine || (a.startLine === b.endLine && a.startColumn < b.endColumn)
  return startsBeforeEnd(left, right) && startsBeforeEnd(right, left)
}

/**
 * 这个项目里，这些文件 / 目录改名之后要改的 import：引用它们的模块路径，以及被挪走的文件自己的相对路径
 * （TypeScript 的 getEditsForFileRename）。按文件归好。
 *
 * TypeScript 只换引号里的那段路径，别的字一个不动：不涉及缩进、分号，引号也是原来的。
 *
 * 一个文件的改动落不下去（在项目之外、读不到）只丢它自己的：各文件的 import 互不相干，不像重构那样套上半套
 * 会把代码改坏。几次改名碰到同一处（先改名又挪目录，合成一步问的时候）只留先算出来的那一份。
 */
export function buildTypeScriptFileRenameEdits(
  context: TypeScriptEditContext,
  renames: readonly TypeScriptFileRename[]
): WorkbenchLanguageServiceFileEdit[] {
  const { formatOptions, preferences } = typeScriptWriteSettings(context)
  const editsByPath = new Map<string, WorkbenchLanguageServiceTextEdit[]>()

  for (const rename of renames) {
    const fileChanges = context.service.getEditsForFileRename(
      rename.previousFileName,
      rename.fileName,
      formatOptions,
      preferences
    )
    for (const fileChange of fileChanges) {
      for (const change of mapTypeScriptFileChanges(context, [fileChange])?.changes ?? []) {
        const edits = editsByPath.get(change.path) ?? []
        for (const edit of change.edits)
          if (!edits.some((existing) => rangesOverlap(existing.range, edit.range))) edits.push(edit)
        editsByPath.set(change.path, edits)
      }
    }
  }

  return [...editsByPath].map(([path, edits]) => ({ path, edits }))
}

/**
 * 又一个项目算出来的改动并进总账。一个文件只认最先给出改动的那个项目：同一个文件在几个项目里（`tsconfig.json`
 * 与连测试一起管的那份配置）算出来的是同一处改动，各套一遍就改坏了。
 */
export function mergeTypeScriptFileRenameEdits(
  merged: Map<string, WorkbenchLanguageServiceFileEdit>,
  changes: readonly WorkbenchLanguageServiceFileEdit[]
): void {
  for (const change of changes) if (!merged.has(change.path)) merged.set(change.path, change)
}
