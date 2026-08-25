import { describe, expect, test } from 'bun:test'

import {
  formatWorkbenchGitCommitRelativeDate,
  parseWorkbenchGitCommitDiff,
} from '../src/renderer/src/models/git/changesPanel.model'

describe('Workbench Git log presentation', () => {
  test('formats recent commits as relative time', () => {
    const now = Date.UTC(2026, 7, 25, 12, 0)
    expect(
      formatWorkbenchGitCommitRelativeDate(
        'en-US',
        {
          sha: 'abc',
          shortSha: 'abc',
          subject: 'Example',
          authorName: 'VelarOS',
          authorEmail: null,
          authoredAt: now - 4 * 60_000,
          refs: [],
        },
        now
      )
    ).toBe('4 minutes ago')
  })

  test('splits a commit diff into files and line statistics', () => {
    const files = parseWorkbenchGitCommitDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-const oldValue = 1',
      '+const newValue = 2',
      ' export { newValue }',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+export const ready = true',
    ].join('\n'))

    expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ['src/a.ts', 1, 1],
      ['src/b.ts', 1, 0],
    ])
    expect(files[0]?.lines.some((line) => line.kind === 'hunk')).toBe(true)
  })
})
