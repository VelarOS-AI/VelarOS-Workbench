/**
 * 项目搜索的替换：没在编辑器里开着的文件在这里换（开着的由编辑器在自己的正文里换，能撤销、不和没保存的改动打架）。
 *
 * 每个文件：
 * - 重新读盘、按编辑器同一套规则解码，用同样的查找词与开关重新找匹配（匹配规则见 `@shared/workbenchTextSearch`）；
 *   点名了哪几处就只换那几处，找不齐说明文件变了，不换。
 * - 经编辑器保存同一条管线写回（FileOperations.saveFile）：不带编码与换行符，按磁盘上现有的写，BOM 照留；
 *   带着搜索时的版本（修改时间与大小），之后被改过就拒绝；原子写。
 * - 替换前的内容先记进本地历史，保存再记下替换后的：没有撤销可按的文件，也能从本地历史找回。
 *
 * 一个文件失败不影响别的文件：结果里逐个说明换了几处、没换成的原因。
 */
import { readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchReplaceContentFileRequest,
  WorkbenchReplaceContentFileResult,
  WorkbenchReplaceContentRequest,
  WorkbenchReplaceContentResult,
} from '@shared/contracts'
import {
  compileWorkbenchTextSearch,
  replaceWorkbenchTextSearchMatches,
  type WorkbenchTextSearchMatcher,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

import type { FileOperations } from './FileOperations'
import type { WorkbenchLocalHistoryStore } from './LocalHistoryStore'
import type { PathResolver } from './PathResolver'
import { decodeWorkbenchText } from './TextCodec'
import { isLikelyTextFile } from './TextFile'

/** 与保存的外部修改检查一致：修改时间差 1 ms 以内算没变。 */
const ModifiedAtToleranceMs = 1

class ContentReplace {
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly files: FileOperations,
    private readonly localHistoryStore: WorkbenchLocalHistoryStore
  ) {}

  public async replaceContent(
    request: WorkbenchReplaceContentRequest
  ): Promise<WorkbenchReplaceContentResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const compiled = compileWorkbenchTextSearch({
      query: request.query,
      matchCase: !!request.matchCase,
      wholeWord: !!request.wholeWord,
      regex: !!request.regex,
    })
    if (compiled.status === 'empty') throw new AppError('VALIDATION', '没有要替换的查找词。')
    if (compiled.status === 'invalid')
      throw new AppError('VALIDATION', `正则表达式有误：${compiled.message}`)

    const files: WorkbenchReplaceContentFileResult[] = []
    for (const file of request.files) {
      try {
        files.push(await this.replaceInFile(projectRoot, compiled.matcher, request.replacement, file))
      } catch (error) {
        const appError = AppError.from(error)
        files.push({
          path: file.path,
          replacedCount: 0,
          error: { message: appError.message, code: appError.code },
        })
      }
    }
    return { projectRoot, files }
  }

  private async replaceInFile(
    projectRoot: string,
    matcher: WorkbenchTextSearchMatcher,
    replacement: string,
    file: WorkbenchReplaceContentFileRequest
  ): Promise<WorkbenchReplaceContentFileResult> {
    const resolved = await this.pathResolver.resolveInsideProject(projectRoot, file.path)
    const fileStats = await stat(resolved.realPath)
    if (
      Math.abs(fileStats.mtimeMs - file.expectedModifiedAt) > ModifiedAtToleranceMs
      || fileStats.size !== file.expectedSize
    )
      throw changedSinceSearch()

    const bytes = await readFile(resolved.realPath)
    if (!isLikelyTextFile(bytes)) throw new AppError('VALIDATION', '不是文本文件。')

    const current = decodeWorkbenchText(bytes)
    if (current.textIssue)
      throw new AppError(
        'VALIDATION',
        '文件现有的编码或换行符不能原样写回，请在编辑器中打开它、确认转换后再替换。'
      )

    const selected = file.matches ? new Set(file.matches.map(workbenchTextSearchRangeKey)) : null
    const replaced = replaceWorkbenchTextSearchMatches(
      current.content,
      matcher,
      replacement,
      selected ? (hit) => selected.has(workbenchTextSearchRangeKey(hit)) : undefined
    )
    if (selected && replaced.count !== selected.size) throw changedSinceSearch()
    if (replaced.count === 0 || replaced.content === current.content)
      return { path: file.path, replacedCount: 0 }

    this.localHistoryStore.capture(projectRoot, file.path, current.content)
    await this.files
      .saveFile({
        projectRoot,
        path: file.path,
        content: replaced.content,
        expectedModifiedAt: file.expectedModifiedAt,
        expectedSize: file.expectedSize,
      })
      .catch((error: unknown) => {
        const appError = AppError.from(error)
        throw appError.code === 'CONFLICT' ? changedSinceSearch() : appError
      })
    return { path: file.path, replacedCount: replaced.count }
  }
}

function changedSinceSearch(): AppError {
  return new AppError('CONFLICT', '文件在搜索之后被改过，请重新搜索后再替换。')
}

export { ContentReplace, ContentReplace as WorkbenchContentReplaceService }
