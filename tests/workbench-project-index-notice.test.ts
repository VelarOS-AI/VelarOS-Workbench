import { describe, expect, test } from 'bun:test'

import { getWorkbenchProjectAiIndexNotice } from '../src/renderer/src/models/project/workbenchProjectIndexNotice'
import type { WorkbenchProjectAiIndexStatus } from '../src/shared/contracts'

describe('Workbench Project index notices', () => {
  test('does not expose CodeGraph notices when the shared resource is not installed', () => {
    const status = createStatus({ version: null, skipped: true })
    expect(getWorkbenchProjectAiIndexNotice(status)).toBeNull()
  })

  test('keeps build notices for an installed CodeGraph resource', () => {
    const status = createStatus({ version: '0.9.7', skipped: true })
    expect(getWorkbenchProjectAiIndexNotice(status)).toMatchObject({
      titleKey: 'workbench.aiIndexCodeGraphSkippedNotice',
      severity: 'warning',
    })
  })
})

function createStatus(
  codeIndex: Pick<NonNullable<WorkbenchProjectAiIndexStatus['codeIndex']>, 'version' | 'skipped'>
): WorkbenchProjectAiIndexStatus {
  return {
    projectRoot: '/project',
    projectId: 'project-id',
    projectName: 'project',
    status: 'ready',
    phase: 'ready',
    memoryId: null,
    indexedAt: 1,
    startedAt: 1,
    updatedAt: 1,
    scannedFiles: 1,
    indexedFiles: 1,
    skippedFiles: 0,
    error: null,
    packageName: null,
    packageManager: null,
    keyFileCount: 0,
    likelyCommandCount: 0,
    sourceRootCount: 1,
    languages: ['typescript'],
    codeIndex: {
      providerId: 'codegraph',
      providerLabel: 'CodeGraph',
      version: codeIndex.version,
      initialized: false,
      indexing: false,
      watching: false,
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      frameworks: [],
      backend: null,
      journalMode: null,
      pendingFileCount: 0,
      lastError: null,
      skipped: codeIndex.skipped,
    },
  }
}
