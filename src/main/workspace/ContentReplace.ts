/**
 * 项目搜索的替换：没在编辑器里开着的文件在这里换（开着的由编辑器在自己的正文里换，能撤销、不和没保存的改动打架）。
 *
 * 每个文件：
 * - 重新读盘、按编辑器同一套规则解码，用同样的查找词与开关重新找匹配（匹配规则见 `@shared/workbenchTextSearch`）；
 *   点名了哪几处就只换那几处，找不齐说明文件变了，不换。跑正则的那一步在搜索 worker 里（见
 *   ContentSearchWorkerHost），卡住就停下，这个文件与后面的文件都不换。
 * - 经编辑器保存同一条管线写回（FileOperations.saveFile）：不带编码与换行符，按磁盘上现有的写，BOM 照留；
 *   带着搜索时的版本（修改时间与大小），之后被改过就拒绝；原子写。
 * - 替换前的内容先记进本地历史，保存再记下替换后的：没有撤销可按的文件，也能从本地历史找回。
 *
 * 一个文件失败不影响别的文件：结果里逐个说明换了几处、没换成的原因。
 */
import { readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchReplaceContentFileRequest,
  type WorkbenchReplaceContentFileResult,
  type WorkbenchReplaceContentRequest,
  type WorkbenchReplaceContentResult,
} from '@shared/contracts/workbench'
import {
  compileWorkbenchTextSearch,
  type WorkbenchTextSearchQuery,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type {
  OpenWorkbenchContentSearchSession,
  WorkbenchContentSearchWorkerSession,
} from './ContentSearchWorkerHost'
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
    private readonly localHistoryStore: WorkbenchLocalHistoryStore,
    private readonly openSearchSession: OpenWorkbenchContentSearchSession
  ) {}

  public async replaceContent(
    request: WorkbenchReplaceContentRequest
  ): Promise<WorkbenchReplaceContentResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const query: WorkbenchTextSearchQuery = {
      query: request.query,
      matchCase: !!request.matchCase,
      wholeWord: !!request.wholeWord,
      regex: !!request.regex,
    }
    // 只编译不执行：正则写错了在这里就说，不用开 worker。
    const compiled = compileWorkbenchTextSearch(query)
    if (compiled.status === 'empty')
      throw new AppError('VALIDATION', workbenchMainText('search.replaceQueryEmpty'))
    if (compiled.status === 'invalid')
      throw new AppError(
        'VALIDATION',
        workbenchMainText('search.invalidRegex', { message: compiled.message })
      )

    const session = this.openSearchSession()
    const files: WorkbenchReplaceContentFileResult[] = []
    // 正则在某个文件上跑不完：后面的文件多半也一样，都不换了。
    let stopped: Nullable<AppError> = null
    try {
      for (const file of request.files) {
        try {
          if (stopped) throw stopped
          files.push(
            await this.replaceInFile(projectRoot, session, query, request.replacement, file)
          )
        } catch (error) {
          const appError = AppError.from(error)
          if (appError.code === 'TIMEOUT') stopped = appError
          files.push({
            path: file.path,
            replacedCount: 0,
            error: { message: appError.message, code: appError.code },
          })
        }
      }
    } finally {
      session.close()
    }
    return { projectRoot, files }
  }

  private async replaceInFile(
    projectRoot: string,
    session: WorkbenchContentSearchWorkerSession,
    query: WorkbenchTextSearchQuery,
    replacement: string,
    file: WorkbenchReplaceContentFileRequest
  ): Promise<WorkbenchReplaceContentFileResult> {
    const resolved = await this.pathResolver.resolveInsideProject(projectRoot, file.path)
    const fileStats = await stat(resolved.realPath)
    if (
      Math.abs(fileStats.mtimeMs - file.expectedModifiedAt) > ModifiedAtToleranceMs ||
      fileStats.size !== file.expectedSize
    )
      throw changedSinceSearch()

    const bytes = await readFile(resolved.realPath)
    if (!isLikelyTextFile(bytes))
      throw new AppError('VALIDATION', workbenchMainText('search.replaceNotText'))

    const current = decodeWorkbenchText(bytes)
    if (current.textIssue)
      throw new AppError('VALIDATION', workbenchMainText('search.replaceFormatNotRoundTrip'))

    const selectedKeys = file.matches
      ? [...new Set(file.matches.map(workbenchTextSearchRangeKey))]
      : undefined
    const replaced = await session.replace(
      { content: current.content, query, replacement, selectedKeys },
      file.path
    )
    if (selectedKeys && replaced.count !== selectedKeys.length) throw changedSinceSearch()
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
  return new AppError('CONFLICT', workbenchMainText('search.changedSinceSearch'))
}

export { ContentReplace, ContentReplace as WorkbenchContentReplaceService }
