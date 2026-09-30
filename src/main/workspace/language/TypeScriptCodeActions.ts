import * as ts from 'typescript'

import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceCodeActionResolveData,
  WorkbenchLanguageServiceEditFormat,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceNewFile,
  WorkbenchLanguageServiceTextEdit,
} from '@shared/contracts'
import { DefaultWorkbenchTabSize, detectWorkbenchIndentation } from '@shared/workbenchIndentation'

import {
  normalizeCommonJsAutoImport,
  WorkbenchTypeScriptUserPreferences,
} from './TypeScriptCompletions'
import {
  buildWorkbenchTypeScriptFormatCodeSettings,
  rangeFromTextSpanInContent,
} from './TypeScriptLanguageFeatures'

/**
 * 一次最多照顾这么多条诊断、交出这么多个动作。光标菜单用不着更多；整行都是错的文件里，也不至于为了一份
 * 菜单把语言服务 worker 占住好几秒。
 */
const MaxQuickFixDiagnostics = 12
const MaxCodeActions = 40

/** 看这么多条语句就够判断一个文件写不写分号（与 TypeScript 自己往已有文件里插代码时的看法一致）。 */
const SemicolonSampleSize = 5
const SemicolonStatementKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.NamespaceExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
])

/** 算一份 TypeScript 改动要知道的东西：哪个服务、哪个文件、此刻的正文，以及别的文件怎么读、路径怎么换。 */
export interface TypeScriptEditContext {
  service: ts.LanguageService
  fileName: string
  content: string
  /** 别的文件此刻的正文（项目里记着的，没有就读盘）；读不到为 null。 */
  readFile: (fileName: string) => Nullable<string>
  /** 项目内相对路径；项目之外的文件为 null。 */
  toRelativePath: (fileName: string) => Nullable<string>
  /** 编辑器里请求文件实际用的缩进。 */
  format?: WorkbenchLanguageServiceEditFormat
}

export interface TypeScriptWorkspaceEdit {
  changes: WorkbenchLanguageServiceFileEdit[]
  createFiles: WorkbenchLanguageServiceNewFile[]
}

/** 用另一套排版把同一份改动再算一遍；算不出来返回 null。 */
export type TypeScriptChangeRecompute = (
  formatOptions: ts.FormatCodeSettings
) => Nullable<readonly ts.FileTextChanges[]> | undefined

/** 往一个文件里写代码时的排版：缩进，以及要不要把分号去掉。 */
interface TypeScriptWriteFormat {
  format: WorkbenchLanguageServiceEditFormat | undefined
  removeSemicolons: boolean
}

let fixableDiagnosticCodes: Nullable<ReadonlySet<number>> = null

/** TypeScript 登记了修复的诊断码；没登记的不必去问，问了也是空。 */
function isFixableDiagnosticCode(code: number): boolean {
  fixableDiagnosticCodes ??= new Set(ts.getSupportedCodeFixes().map(Number))
  return fixableDiagnosticCodes.has(code)
}

/**
 * 这个文件写不写分号。TypeScript 往已有文件里插代码时自己会看；新建文件（「移到新文件」）没有正文可看，一律
 * 带分号，不写分号的项目里新文件就成了另一种风格。所以新建文件时先替它看好原文件，再明说出来。
 */
function omitsSemicolons(sourceFile: ts.SourceFile): boolean {
  let withSemicolon = 0
  let withoutSemicolon = 0
  const visit = (node: ts.Node): true | undefined => {
    if (SemicolonStatementKinds.has(node.kind)) {
      if (node.getLastToken(sourceFile)?.kind === ts.SyntaxKind.SemicolonToken) withSemicolon += 1
      else withoutSemicolon += 1
    }
    if (withSemicolon + withoutSemicolon >= SemicolonSampleSize) return true
    return ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)

  // 只有一句没写分号说明不了什么：可能只是还没写完。
  if (withSemicolon === 0 && withoutSemicolon <= 1) return false
  return withSemicolon / withoutSemicolon <= 1 / SemicolonSampleSize
}

/** 文件里已经有 import 就照它的引号写（TypeScript 自己看）；一个都没有时用补全自动导入的那种。 */
function quotePreferenceFor(sourceFile: ts.SourceFile | undefined): ts.UserPreferences['quotePreference'] {
  const hasModuleSpecifier = sourceFile?.statements.some(
    (statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && !!statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
  )
  return hasModuleSpecifier ? 'auto' : WorkbenchTypeScriptUserPreferences.quotePreference
}

function formatCodeSettingsFor(write: TypeScriptWriteFormat): ts.FormatCodeSettings {
  return {
    ...buildWorkbenchTypeScriptFormatCodeSettings(write.format),
    // 已有的文件 TypeScript 自己看它写不写分号；只有新建文件要明说。
    semicolons: write.removeSemicolons ? ts.SemicolonPreference.Remove : ts.SemicolonPreference.Ignore,
  }
}

function writeFormatKey(write: TypeScriptWriteFormat): string {
  const settings = formatCodeSettingsFor(write)
  return [settings.convertTabsToSpaces, settings.indentSize, settings.tabSize, write.removeSemicolons].join(':')
}

/** 语言服务写代码时的排版与偏好：缩进跟编辑器里这个文件的，引号跟文件现有的写法。 */
export function typeScriptWriteSettings(context: TypeScriptEditContext): {
  formatOptions: ts.FormatCodeSettings
  preferences: ts.UserPreferences
} {
  const sourceFile = context.service.getProgram()?.getSourceFile(context.fileName)
  return {
    formatOptions: formatCodeSettingsFor({ format: context.format, removeSemicolons: false }),
    preferences: {
      ...WorkbenchTypeScriptUserPreferences,
      quotePreference: quotePreferenceFor(sourceFile),
      // 「移到新文件」这类重构要往还不存在的文件里写。
      allowTextChangesInNewFiles: true,
    },
  }
}

/**
 * 一份改动落到请求文件之外的文件上时，那个文件自己用什么缩进：按它的正文识别；识别不出来，或者和请求文件
 * 一样，就用请求文件的（返回 undefined）。
 */
function detectOwnEditFormat(
  content: string,
  requestFormat: WorkbenchLanguageServiceEditFormat | undefined
): WorkbenchLanguageServiceEditFormat | undefined {
  const detected = detectWorkbenchIndentation(content)
  if (!detected) return undefined
  if (detected.style === 'tab') {
    const tabSize = requestFormat?.tabSize ?? DefaultWorkbenchTabSize
    return { tabSize, indentSize: tabSize, insertSpaces: false }
  }
  return { tabSize: detected.size, indentSize: detected.size, insertSpaces: true }
}

/**
 * 同一个位置上的几处改动并成一处。TypeScript 允许在同一个偏移上先插一段、再插（或替换）一段，意思是按先后
 * 接起来；拆开交出去，接收方从后往前套的时候第二处会落到第一处刚插进去的字上。
 */
function mergeTextChangesAtSameOffset(textChanges: readonly ts.TextChange[]): ts.TextChange[] {
  const merged: ts.TextChange[] = []
  for (const change of [...textChanges].sort((left, right) => left.span.start - right.span.start)) {
    const previous = merged.at(-1)
    if (previous && previous.span.start === change.span.start && previous.span.length === 0) {
      merged[merged.length - 1] = {
        span: change.span,
        newText: previous.newText + change.newText,
      }
      continue
    }
    merged.push(change)
  }
  return merged
}

/**
 * TypeScript 的一组文件改动 → 编辑器认的改动（行列范围）与要新建的文件。有一处落不下去（文件在项目之外、
 * 读不到、范围越界）整组作废：只套上半套改动，比不改更糟。
 *
 * TypeScript 一次只收一套排版，整组改动都按请求文件的缩进写。落在别的文件上的那部分，按那个文件自己的缩进
 * 再算一遍（`recompute`）后换上；新建的文件在原文件不写分号时也照着不写。算不了第二遍的就用第一遍的。
 */
export function mapTypeScriptFileChanges(
  context: TypeScriptEditContext,
  fileChanges: readonly ts.FileTextChanges[],
  {
    normalizeImports = false,
    recompute,
  }: { normalizeImports?: boolean; recompute?: TypeScriptChangeRecompute } = {}
): Nullable<TypeScriptWorkspaceEdit> {
  const editsByPath = new Map<string, WorkbenchLanguageServiceTextEdit[]>()
  const createFiles: WorkbenchLanguageServiceNewFile[] = []
  const requestWrite: TypeScriptWriteFormat = { format: context.format, removeSemicolons: false }
  const recomputed = new Map<string, Nullable<readonly ts.FileTextChanges[]>>()
  const changesFor = (
    write: TypeScriptWriteFormat,
    fileChange: ts.FileTextChanges
  ): ts.FileTextChanges => {
    const key = writeFormatKey(write)
    if (!recompute || key === writeFormatKey(requestWrite)) return fileChange
    if (!recomputed.has(key)) recomputed.set(key, recompute(formatCodeSettingsFor(write)) ?? null)
    return (
      recomputed.get(key)?.find(
        (candidate) =>
          candidate.fileName === fileChange.fileName && !candidate.isNewFile === !fileChange.isNewFile
      ) ?? fileChange
    )
  }

  for (const fileChange of fileChanges) {
    const path = context.toRelativePath(fileChange.fileName)
    if (!path) return null

    if (fileChange.isNewFile) {
      const sourceFile = context.service.getProgram()?.getSourceFile(context.fileName)
      const created = changesFor(
        { format: context.format, removeSemicolons: !!sourceFile && omitsSemicolons(sourceFile) },
        fileChange
      )
      createFiles.push({
        path,
        content: created.textChanges.map((change) => change.newText).join(''),
      })
      continue
    }

    const isRequestFile = fileChange.fileName === context.fileName
    const content = isRequestFile ? context.content : context.readFile(fileChange.fileName)
    if (content == null) return null

    const effective = isRequestFile
      ? fileChange
      : changesFor(
          {
            format: detectOwnEditFormat(content, context.format) ?? context.format,
            removeSemicolons: false,
          },
          fileChange
        )
    const edits = editsByPath.get(path) ?? []
    for (const change of mergeTextChangesAtSameOffset(effective.textChanges)) {
      const range = rangeFromTextSpanInContent(content, fileChange.fileName, change.span)
      if (!range) return null
      edits.push({
        range,
        newText: normalizeImports
          ? normalizeCommonJsAutoImport(fileChange.fileName, change.newText)
          : change.newText,
      })
    }
    editsByPath.set(path, edits)
  }

  return {
    changes: [...editsByPath]
      .filter(([, edits]) => edits.length > 0)
      .map(([path, edits]) => ({ path, edits })),
    createFiles,
  }
}

interface FixableDiagnostic {
  start: number
  length: number
  code: number
  category: ts.DiagnosticCategory
}

/** 请求文件自己的诊断（语法、类型、建议），只留 TypeScript 有修复可给的。 */
function collectFixableDiagnostics(context: TypeScriptEditContext): FixableDiagnostic[] {
  const { service, fileName } = context
  const seen = new Set<string>()
  const diagnostics: FixableDiagnostic[] = []
  for (const diagnostic of [
    ...service.getSyntacticDiagnostics(fileName),
    ...service.getSemanticDiagnostics(fileName),
    ...service.getSuggestionDiagnostics(fileName),
  ]) {
    if (diagnostic.file?.fileName !== fileName) continue
    if (diagnostic.start === undefined || diagnostic.length === undefined) continue
    if (!isFixableDiagnosticCode(diagnostic.code)) continue
    const key = `${diagnostic.start}:${diagnostic.length}:${diagnostic.code}`
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push({
      start: diagnostic.start,
      length: diagnostic.length,
      code: diagnostic.code,
      category: diagnostic.category,
    })
  }
  return diagnostics
}

/**
 * 这段范围上的诊断有哪些修复。诊断按当前正文现算，不靠编辑器里那份（刚改完字，它可能还没刷新）；错误排在
 * 警告、建议前面。TypeScript 给了「同类问题一起修」的，文件里确实还有同一种问题时多列一项，选中时才算。
 */
export function buildTypeScriptQuickFixes(
  context: TypeScriptEditContext,
  range: { start: number; end: number }
): WorkbenchLanguageServiceCodeAction[] {
  const { service, fileName } = context
  const diagnostics = collectFixableDiagnostics(context)
  const targets = diagnostics
    .filter((diagnostic) =>
      diagnostic.start <= range.end && diagnostic.start + diagnostic.length >= range.start
    )
    .sort((left, right) => left.category - right.category || left.start - right.start)
    .slice(0, MaxQuickFixDiagnostics)
  if (targets.length === 0) return []

  const { formatOptions, preferences } = typeScriptWriteSettings(context)
  const actions: WorkbenchLanguageServiceCodeAction[] = []
  const fixAllActions: WorkbenchLanguageServiceCodeAction[] = []
  const seenActions = new Set<string>()
  const seenFixIds = new Set<string>()

  for (const target of targets) {
    const fixesWith = (options: ts.FormatCodeSettings): readonly ts.CodeFixAction[] =>
      service.getCodeFixesAtPosition(
        fileName,
        target.start,
        target.start + target.length,
        [target.code],
        options,
        preferences
      )
    let fixes: readonly ts.CodeFixAction[]
    try {
      fixes = fixesWith(formatOptions)
    } catch (error) {
      // arch-guard:silent-catch-ok 某个修复自己算不出来（TypeScript 内部断言失败）不连累其余的；取消照常往外抛。
      if (error instanceof ts.OperationCanceledException) throw error
      continue
    }

    for (const fix of fixes) {
      const edit = mapTypeScriptFileChanges(context, fix.changes, {
        normalizeImports: fix.fixName === 'import',
        recompute: (options) =>
          fixesWith(options).find(
            (candidate) =>
              candidate.fixName === fix.fixName && candidate.description === fix.description
          )?.changes,
      })
      // 只有「装一个包」这类要跑命令的修复没有改动可套，不列。
      if (!edit || (edit.changes.length === 0 && edit.createFiles.length === 0)) continue

      const key = `${fix.description}\u0000${JSON.stringify(edit)}`
      if (!seenActions.has(key)) {
        seenActions.add(key)
        actions.push({
          title: fix.description,
          kind: 'quickfix',
          changes: edit.changes,
          createFiles: edit.createFiles.length > 0 ? edit.createFiles : undefined,
        })
      }

      const fixId = fix.fixId
      if (typeof fixId !== 'string' || !fix.fixAllDescription || seenFixIds.has(fixId)) continue
      // 文件里只有这一处，「全部修复」和上面那一项是一回事。
      const hasSibling = diagnostics.some(
        (diagnostic) =>
          diagnostic.code === target.code
          && (diagnostic.start !== target.start || diagnostic.length !== target.length)
      )
      if (!hasSibling) continue
      seenFixIds.add(fixId)
      fixAllActions.push({
        title: fix.fixAllDescription,
        kind: 'quickfix',
        changes: [],
        resolve: { kind: 'fix-all', fixId },
      })
    }
  }

  return [...actions, ...fixAllActions].slice(0, MaxCodeActions)
}

/** 选中了一个要现算的动作：算出它的改动；算不出来（落到项目之外……）为 null。 */
export function resolveTypeScriptCodeAction(
  context: TypeScriptEditContext,
  resolve: WorkbenchLanguageServiceCodeActionResolveData
): Nullable<TypeScriptWorkspaceEdit> {
  const { formatOptions, preferences } = typeScriptWriteSettings(context)
  const changesWith = (options: ts.FormatCodeSettings): readonly ts.FileTextChanges[] =>
    context.service.getCombinedCodeFix(
      { type: 'file', fileName: context.fileName },
      resolve.fixId,
      options,
      preferences
    ).changes
  return mapTypeScriptFileChanges(context, changesWith(formatOptions), {
    normalizeImports: resolve.fixId === 'fixMissingImport',
    recompute: changesWith,
  })
}
