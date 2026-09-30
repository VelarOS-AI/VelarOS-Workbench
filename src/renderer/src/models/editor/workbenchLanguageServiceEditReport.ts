import type {
  WorkbenchLanguageServiceFileChangeFailure,
  WorkbenchLanguageServiceFileChangeFailureReason,
} from './workbenchLanguageServiceFileChanges'

/** 哪一种跨文件改动：各有各的说法，也各有各的「什么时候不必说」。 */
export type WorkbenchLanguageServiceEditReportKind = 'rename' | 'code-action' | 'import-update'

export interface WorkbenchLanguageServiceEditOutcome {
  /** 页面这边改成了的文件数（开着的改了编辑缓冲，没开着的写了盘）。 */
  changedFiles: number
  failures: readonly WorkbenchLanguageServiceFileChangeFailure[]
  /** 新建成了的文件。 */
  createdPaths?: readonly string[]
}

export interface WorkbenchLanguageServiceEditReport {
  tone: 'success' | 'warning'
  title: string
  description?: string
}

const FailureReasonMessageKeys: Readonly<Record<
  Exclude<WorkbenchLanguageServiceFileChangeFailureReason, 'error'>,
  string
>> = {
  'read-only': 'workbench.languageServiceEditReadOnly',
  'unsupported-text': 'workbench.languageServiceEditUnsupportedText',
  'changed-on-disk': 'workbench.languageServiceEditChangedOnDisk',
  'changed-in-editor': 'workbench.languageServiceEditChangedInEditor',
}

const ReportMessageKeys: Readonly<Record<
  WorkbenchLanguageServiceEditReportKind,
  { applied: string; partial: string }
>> = {
  rename: {
    applied: 'workbench.languageServiceEditsApplied',
    partial: 'workbench.languageServiceEditsPartial',
  },
  'code-action': {
    applied: 'workbench.languageServiceActionApplied',
    partial: 'workbench.languageServiceActionPartial',
  },
  'import-update': {
    applied: 'workbench.languageServiceImportsUpdated',
    partial: 'workbench.languageServiceImportsPartial',
  },
}

/**
 * 一次跨文件改动做完以后告诉用户什么：一共改了几个文件；有落不下去的，逐个说明是哪个文件、为什么。
 * `editedInEditor` 是编辑器自己已经改好的文件数（发起动作的当前文件）。
 *
 * 改名总要报（改了几个文件是用户最想确认的）。快速修复、重构只动了眼前这个文件时不报——改动就在眼前；
 * 碰了别的文件或新建了文件才报，那些改动用户看不见。文件改名之后更新 import，没有文件要改就不报。
 */
export function buildWorkbenchLanguageServiceEditReport(
  outcome: WorkbenchLanguageServiceEditOutcome,
  {
    kind,
    editedInEditor = 0,
    translate,
  }: {
    kind: WorkbenchLanguageServiceEditReportKind
    editedInEditor?: number
    translate: (key: string, params?: Record<string, string | number>) => string
  }
): Nullable<WorkbenchLanguageServiceEditReport> {
  const createdPaths = outcome.createdPaths ?? []
  const elsewhere = outcome.changedFiles + createdPaths.length
  const count = elsewhere + editedInEditor
  const keys = ReportMessageKeys[kind]
  const created = createdPaths
    .map((path) => translate('workbench.languageServiceActionCreatedFile', { path }))
    .join(translate('workbench.languageServiceEditFailureSeparator'))

  if (outcome.failures.length === 0) {
    if (kind !== 'rename' && elsewhere === 0) return null
    return {
      tone: 'success',
      title: translate(keys.applied, { count }),
      description: created || undefined,
    }
  }

  const failed = outcome.failures
    .map((failure) =>
      translate('workbench.languageServiceEditFailedFile', {
        path: failure.path,
        reason:
          failure.reason === 'error'
            ? (failure.message ?? '')
            : translate(FailureReasonMessageKeys[failure.reason]),
      })
    )
    .join(translate('workbench.languageServiceEditFailureSeparator'))
  return {
    tone: 'warning',
    title: translate(keys.partial, { count }),
    description: [created, failed]
      .filter(Boolean)
      .join(translate('workbench.languageServiceEditFailureSeparator')),
  }
}
