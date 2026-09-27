import { describe, expect, test } from 'bun:test'

import {
  formatWorkbenchGitCommitRelativeDate,
  parseWorkbenchGitCommitDiff,
  unquoteWorkbenchGitPath,
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

  test('reads quoted, spaced, deleted and renamed file names from a commit diff', () => {
    const files = parseWorkbenchGitCommitDiff([
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      'index 1111111..2222222 100644',
      '--- "a/tab\\there.txt"',
      '+++ "b/tab\\there.txt"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/\\346\\226\\207\\346\\241\\243.txt" "b/\\346\\226\\207\\346\\241\\243.txt"',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/with space.txt b/with space.txt',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/with space.txt\t',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/logo b.png b/logo b.png',
      'Binary files a/logo b.png and b/logo b.png differ',
    ].join('\n'))

    expect(files.map((file) => file.path)).toEqual([
      'tab\there.txt',
      '文档.txt',
      'with space.txt',
      'new name.txt',
      'logo b.png',
    ])
    expect(unquoteWorkbenchGitPath('"quote\\"and\\\\slash"')).toBe('quote"and\\slash')
    expect(unquoteWorkbenchGitPath('plain name')).toBe('plain name')
  })
})
