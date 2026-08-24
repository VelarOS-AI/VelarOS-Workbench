import type { WorkbenchProjectAiIndexStatus } from '@shared/contracts'

export type WorkbenchProjectAiIndexNoticeSeverity = 'warning' | 'error'

export interface WorkbenchProjectAiIndexNotice {
  key: string
  severity: WorkbenchProjectAiIndexNoticeSeverity
  titleKey: string
  description: Nullable<string>
}

function projectNoticeKey(status: WorkbenchProjectAiIndexStatus, reason: string): string {
  return [
    status.projectRoot || status.projectId,
    reason,
    status.updatedAt ?? status.indexedAt ?? '',
  ].join(':')
}

function normalizeNoticeDescription(value: LooseOptional<string>): Nullable<string> {
  const text = value?.trim() ?? ''
  return text ? text : null
}

export function getWorkbenchProjectAiIndexNotice(
  status: Nullable<WorkbenchProjectAiIndexStatus>
): Nullable<WorkbenchProjectAiIndexNotice> {
  if (!status) return null

  if (status.status === 'failed') {
    const description = normalizeNoticeDescription(status.error)
    return {
      key: projectNoticeKey(status, `failed:${status.error ?? ''}`),
      severity: 'error',
      titleKey: 'workbench.aiIndexFailed',
      description,
    }
  }

  const codeIndex = status.codeIndex
  if (!codeIndex || codeIndex.initialized) return null

  // 未安装共享 CodeGraph 时相关功能整体隐藏，不用“跳过构建”通知反向暴露一个不存在的功能。
  if (codeIndex.providerId === 'codegraph' && codeIndex.version === null && codeIndex.skipped) return null

  if (codeIndex.lastError) {
    const description = normalizeNoticeDescription(codeIndex.lastError)
    return {
      key: projectNoticeKey(status, `codegraph-error:${codeIndex.lastError}`),
      severity: 'warning',
      titleKey: 'workbench.aiIndexCodeGraphNotBuiltNotice',
      description,
    }
  }

  if (codeIndex.skipped) {
    const key = projectNoticeKey(status, 'codegraph-skipped')
    return {
      key,
      severity: 'warning',
      titleKey: 'workbench.aiIndexCodeGraphSkippedNotice',
      description: null,
    }
  }

  return null
}
