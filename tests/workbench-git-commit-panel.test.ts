import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import { isSameWorkbenchGitLog } from '../src/renderer/src/models/git/changesPanel.model'
import {
  buildCommitPanelGroups,
  deriveRollbackTargetItems,
  isCommitPanelRollbackDeletion,
  summarizeCommitPanelCommitAll,
} from '../src/renderer/src/models/git/commitPanel.model'
import { isWorkbenchGitDiffAffectedByChange } from '../src/renderer/src/models/git/workbenchGitDiffModel'
import {
  buildWorkbenchGitChangeItems,
  buildWorkbenchGitDecorationMap,
  getWorkbenchGitChangeItemTone,
} from '../src/renderer/src/models/git/workbenchGitModel'
import { type WorkspaceGitLogEntry } from '../src/shared/contracts/system'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

const items = buildWorkbenchGitChangeItems([
  { path: 'src/edited.ts', indexStatus: ' ', workTreeStatus: 'M' },
  { path: 'src/partly.ts', indexStatus: 'M', workTreeStatus: 'M' },
  { path: 'src/added.ts', indexStatus: 'A', workTreeStatus: ' ' },
  { path: 'src/moved.ts', originalPath: 'src/old.ts', indexStatus: 'R', workTreeStatus: ' ' },
  { path: 'notes.md', indexStatus: '?', workTreeStatus: '?' },
  { path: 'src/both.ts', indexStatus: 'U', workTreeStatus: 'U' },
  { path: 'src/theirs.ts', indexStatus: 'D', workTreeStatus: 'U' },
])

function item(itemPath: string) {
  const found = items.find((candidate) => candidate.path === itemPath)
  assert.ok(found, itemPath)
  return found
}

void describe('Workbench commit panel', () => {
  void test('shows unmerged files as merge conflicts, first and in their own group', () => {
    assert.equal(item('src/both.ts').group, 'conflicted')
    assert.equal(item('src/theirs.ts').group, 'conflicted')
    assert.equal(getWorkbenchGitChangeItemTone(item('src/both.ts')), 'conflicted')
    assert.deepEqual(
      buildCommitPanelGroups(items).map((group) => [
        group.id,
        group.items.map((entry) => entry.path),
      ]),
      [
        ['conflicted', ['src/both.ts', 'src/theirs.ts']],
        ['staged', ['src/added.ts', 'src/moved.ts', 'src/partly.ts']],
        ['changed', ['src/edited.ts', 'src/partly.ts']],
        ['untracked', ['notes.md']],
      ]
    )
    // 文件树里的目录跟着显示成冲突。
    assert.equal(buildWorkbenchGitDecorationMap(items).get('src')?.tone, 'conflicted')
  })

  void test('rolls back only files the user explicitly chose, never everything', () => {
    assert.deepEqual(deriveRollbackTargetItems(items, new Set(), null), [])
    assert.deepEqual(
      deriveRollbackTargetItems(items, new Set(), item('notes.md')).map((entry) => entry.path),
      ['notes.md']
    )
    assert.deepEqual(
      deriveRollbackTargetItems(
        items,
        new Set(['src/edited.ts', 'src/both.ts']),
        item('notes.md')
      ).map((entry) => entry.path),
      ['src/edited.ts']
    )
    // 已暂存的那一侧不回滚（要先取消暂存）：暂存了一部分的文件只回滚没暂存的那部分。
    assert.deepEqual(
      deriveRollbackTargetItems(items, new Set(['src/added.ts', 'src/partly.ts']), null).map(
        (entry) => `${entry.group} ${entry.path}`
      ),
      ['unstaged src/partly.ts']
    )
  })

  void test('tells which rolled-back files are deleted from disk for good', () => {
    assert.deepEqual(
      items.filter((entry) => isCommitPanelRollbackDeletion(entry)).map((entry) => entry.path),
      ['src/added.ts', 'notes.md']
    )
    assert.deepEqual(
      summarizeCommitPanelCommitAll(items.filter((entry) => entry.group !== 'conflicted')),
      {
        count: 5,
        untracked: 1,
      }
    )
  })

  void test('asks before committing everything and names untracked files in the question', () => {
    assert.equal(
      translateWorkbenchAppMessage('zh-CN', 'workbench.gitCommitAllConfirm', {
        count: 5,
        untracked: 2,
      }),
      '没有勾选文件，要提交全部 5 个改动（含 2 个未跟踪文件）吗？'
    )
    assert.equal(
      translateWorkbenchAppMessage('en-US', 'workbench.gitCommitAllTrackedConfirm', { count: 3 }),
      'No files are checked. Commit all 3 changes?'
    )
    for (const key of [
      'workbench.commitGroupConflicted',
      'workbench.gitConflictKinds.UU',
      'workbench.gitConflictKinds.DU',
      'workbench.gitMarkResolved',
      'workbench.gitCommitConflictsBlocked',
      'workbench.gitDiscardDeletesUntrackedFiles',
      'workbench.gitCommitAllConfirmTitle',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key)
      const en = translateWorkbenchAppMessage('en-US', key)
      assert.notEqual(en, key, `en-US is missing ${key}`)
      assert.notEqual(zh, en, `zh-CN is missing ${key}`)
    }

    const panel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    // 没勾选时不再默默拿全部改动去提交、去回滚。
    assert.doesNotMatch(panel, /selectedItems\.length \? selectedItems : changeItems\n/)
    assert.doesNotMatch(panel, /requestRollback\(actionItems\)/)
    assert.match(panel, /requestRollback\(rollbackTargets\)/)
    assert.match(panel, /setCommitAllRequest\(\[\.\.\.changeItems\]\)/)
    assert.match(panel, /<Dialog[\s\S]*open=\{!!commitAllRequest\}/)
    assert.match(panel, /performWorkspaceGitFileAction\([\s\S]*'resolve'/)
  })

  void test('reloads an open diff when the file or HEAD changes', () => {
    const renamed = { path: 'src/new.ts', originalPath: 'src/old.ts' }
    assert.equal(isWorkbenchGitDiffAffectedByChange(renamed, { paths: ['src/new.ts'] }), true)
    assert.equal(isWorkbenchGitDiffAffectedByChange(renamed, { paths: ['src/old.ts'] }), true)
    assert.equal(isWorkbenchGitDiffAffectedByChange(renamed, { paths: ['.git/HEAD'] }), true)
    assert.equal(isWorkbenchGitDiffAffectedByChange(renamed, { paths: ['src/other.ts'] }), false)
  })

  void test('refreshes the Git log in place instead of flashing a loading state', () => {
    const commit: WorkspaceGitLogEntry = {
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      subject: 'Initial',
      authorName: 't',
      authorEmail: null,
      authoredAt: 1,
      parents: [],
      refs: [{ kind: 'branch', name: 'main', current: true }],
    }
    assert.equal(isSameWorkbenchGitLog([commit], [{ ...commit }]), true)
    assert.equal(
      isSameWorkbenchGitLog([commit], [{ ...commit, refs: [{ kind: 'branch', name: 'main' }] }]),
      false
    )
    assert.equal(isSameWorkbenchGitLog([commit], []), false)

    // 日志归 useWorkbenchGitLog 管：「读取中」只在这个项目、这个范围一页都没读到时显示；同一份重读时
    // 原地更新，内容没变就连状态都不换。
    const panel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')
    const hook = readSource('src/renderer/src/hooks/useWorkbenchGitLog.ts')
    assert.match(
      panel,
      /useWorkbenchGitLog\(\{\s*workspaceRoot,\s*branch: logBranch,\s*enabled: isRepository,\s*revision,?\s*\}\)/
    )
    assert.doesNotMatch(`${panel}\n${hook}`, /setLogLoading\(true\)|setIsLoading\(true\)/)
    assert.match(hook, /isLoading: enabled && !current,/)
    assert.match(
      hook,
      /if \(latest && !latest\.error && isSameWorkbenchGitLog\(latest\.commits, result\.commits\)\) return/
    )
  })
})
