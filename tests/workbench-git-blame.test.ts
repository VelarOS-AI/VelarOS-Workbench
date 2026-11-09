import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  setWorkbenchGitBlame,
  workbenchGitBlameAtLine,
  workbenchGitBlameField,
} from '../src/renderer/src/models/editor/workbenchGitBlame'
import { parseWorkbenchGitBlame } from '../src/shared/workbenchGitBlame'

import { createGitService, git, withRepository } from './helpers/gitRepository'

/** 每一行归谁：提交说明，还没提交的行是 null。 */
function owners(blame: { commits: Array<{ summary: string }>; lines: number[] }): Array<string | null> {
  return blame.lines.map((index) => blame.commits[index]?.summary ?? null)
}

async function commitAs(root: string, author: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, [
    '-c',
    `user.name=${author}`,
    '-c',
    `user.email=${author.toLowerCase()}@example.com`,
    'commit',
    '-q',
    '-m',
    message,
  ])
}

void describe('Git blame for the editor', () => {
  void test('parses SHA-1 and SHA-256 incremental blame and rejects other object-id widths', () => {
    for (const width of [40, 64]) {
      const first = 'a'.repeat(width)
      const second = 'b'.repeat(width)
      const blame = parseWorkbenchGitBlame(
        [
          `${second} 2 2 1`,
          'author Bob',
          'author-time 1700000100',
          'summary second change',
          'filename a.ts',
          `${first} 1 1 1`,
          'author Alice',
          'author-time 1700000000',
          'summary first',
          'filename a.ts',
          `${'0'.repeat(width)} 3 3 1`,
          'author Not Committed Yet',
          'filename a.ts',
          `${first} 3 4 2`,
          'filename a.ts',
          '',
        ].join('\n')
      )
      assert.deepEqual(blame.commits, [
        { sha: second, author: 'Bob', authorTime: 1_700_000_100, summary: 'second change' },
        { sha: first, author: 'Alice', authorTime: 1_700_000_000, summary: 'first' },
      ])
      assert.deepEqual(owners(blame), ['first', 'second change', null, 'first', 'first'])
    }
    assert.deepEqual(parseWorkbenchGitBlame(`${'a'.repeat(48)} 1 1 1\nfilename a.ts\n`), {
      commits: [],
      lines: [],
    })
  })

  void test('attributes each line to its commit, and unsaved editor text to no commit', async () => {
    await withRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'a.ts'), 'one\ntwo\nthree\n')
      await commitAs(root, 'Alice', 'first')
      await writeFile(join(root, 'a.ts'), 'one\nTWO\nthree\n')
      await commitAs(root, 'Bob', 'second change')

      const saved = await service.getBlame(root, { path: 'a.ts' })
      assert.deepEqual(owners(saved), ['first', 'second change', 'first'])
      assert.deepEqual(saved.commits.map((commit) => commit.author).sort(), ['Alice', 'Bob'])
      assert.ok(saved.commits.every((commit) => commit.authorTime > 1_600_000_000))

      // 编辑器里还没保存的正文：插进来的行不属于任何提交，其余行照样对得上。
      const unsaved = await service.getBlame(root, {
        path: 'a.ts',
        content: 'zero\none\nTWO\nthree\n',
        encoding: 'utf-8',
        eol: 'lf',
      })
      assert.deepEqual(owners(unsaved), [null, 'first', 'second change', 'first'])
    })
  })

  void test('a CRLF file is not reported as changed on every line', async () => {
    await withRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'win.txt'), 'one\r\ntwo\r\n')
      await commitAs(root, 'Alice', 'windows file')
      // 编辑器的正文是 LF，连同文件的换行符一起给。
      const blame = await service.getBlame(root, {
        path: 'win.txt',
        content: 'one\ntwo\nthree\n',
        encoding: 'utf-8',
        eol: 'crlf',
      })
      assert.deepEqual(owners(blame), ['windows file', 'windows file', null])
    })
  })

  void test('a file that is not in the repository yet has no blame', async () => {
    await withRepository(async (root) => {
      const service = createGitService()
      await writeFile(join(root, 'tracked.ts'), 'x\n')
      await commitAs(root, 'Alice', 'base')
      await writeFile(join(root, 'new.ts'), 'fresh\n')
      const blame = await service.getBlame(root, { path: 'new.ts' })
      assert.deepEqual(blame.lines, [])
      assert.deepEqual(blame.commits, [])
    })
  })
})

void describe('Git blame annotations follow edits', () => {
  const alice = { sha: 'a'.repeat(40), author: 'Alice', authorTime: 1_700_000_000, summary: 'first' }
  const bob = { sha: 'b'.repeat(40), author: 'Bob', authorTime: 1_700_000_100, summary: 'second' }
  const authors = (state: EditorState): Array<string | null> =>
    Array.from({ length: state.doc.lines }, (_, index) =>
      workbenchGitBlameAtLine(state, index + 1)?.author ?? null
    )
  const annotated = (): EditorState =>
    EditorState.create({ doc: 'one\ntwo\nthree\nfour', extensions: [workbenchGitBlameField] }).update({
      effects: setWorkbenchGitBlame.of({ commits: [alice, bob], lines: [0, 1, -1, 0] }),
    }).state

  void test('each line shows its commit; uncommitted lines show none', () => {
    assert.deepEqual(authors(annotated()), ['Alice', 'Bob', null, 'Alice'])
    assert.equal(workbenchGitBlameAtLine(annotated(), 99), null)
  })

  void test('lines keep their commit when whole lines are added or removed around them', () => {
    const state = annotated()
    const insertedAbove = state.update({ changes: { from: 0, insert: 'zero\n' } }).state
    assert.deepEqual(authors(insertedAbove), [null, 'Alice', 'Bob', null, 'Alice'])

    const insertedBetween = state.update({
      changes: { from: state.doc.line(2).from, insert: 'new a\nnew b\n' },
    }).state
    assert.deepEqual(authors(insertedBetween), ['Alice', null, null, 'Bob', null, 'Alice'])

    const removed = state.update({ changes: { from: 0, to: state.doc.line(2).from } }).state
    assert.deepEqual(authors(removed), ['Bob', null, 'Alice'])
  })

  void test('an edited line no longer belongs to its commit', () => {
    const state = annotated()
    const lineTwo = state.doc.line(2)
    const appended = state.update({ changes: { from: lineTwo.to, insert: '!' } }).state
    assert.deepEqual(authors(appended), ['Alice', null, null, 'Alice'])

    const typedAtStart = state.update({ changes: { from: lineTwo.from, insert: 'x' } }).state
    assert.deepEqual(authors(typedAtStart), ['Alice', null, null, 'Alice'])

    // 回车把一行拆成两行：两半都算改过。
    const split = state.update({ changes: { from: lineTwo.from + 1, insert: '\n' } }).state
    assert.deepEqual(authors(split), ['Alice', null, null, null, 'Alice'])

    // 把两行并成一行。
    const joined = state.update({ changes: { from: lineTwo.from - 1, to: lineTwo.from } }).state
    assert.deepEqual(authors(joined), [null, null, 'Alice'])
  })

  void test('hiding blame clears every line', () => {
    const hidden = annotated().update({ effects: setWorkbenchGitBlame.of(null) }).state
    assert.deepEqual(authors(hidden), [null, null, null, null])
  })
})
