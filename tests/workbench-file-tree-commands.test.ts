import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  canDropTreeEntries,
  type FileTreeDropNode,
  getDefaultCreateName,
  resolveTreeCreateDirectoryPath,
  resolveTreeDropDirectoryPath,
} from '../src/renderer/src/models/files/fileTree.model'
import {
  resolveTreeCreateParentPath,
  selectTreeEntriesToMove,
} from '../src/renderer/src/models/files/workbenchTreeMutation'
import type { WorkbenchDirectoryEntry } from '../src/shared/contracts'

/**
 * 文件树只做用户要它做的事：新建只走右键菜单，落在右键的那一项所在的位置；
 * 拖到顶层（Arborist 的内部根节点）就是移到工程根目录。
 */

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function entry(entryPath: string, type: WorkbenchDirectoryEntry['type']): WorkbenchDirectoryEntry {
  return {
    name: entryPath.split('/').at(-1) ?? entryPath,
    path: entryPath,
    type,
    size: null,
    modifiedAt: null,
    hasChildren: type === 'directory',
  }
}

function node(entryPath: string, type: WorkbenchDirectoryEntry['type']): FileTreeDropNode {
  return { isRoot: false, data: { entry: entry(entryPath, type) } }
}

/** Arborist 的内部根节点：数据里只有它自己的 id，没有条目。 */
const arboristRoot = {
  isRoot: true,
  data: { id: '__REACT_ARBORIST_INTERNAL_ROOT__' },
} as unknown as FileTreeDropNode

void describe('Workbench file tree commands', () => {
  void test('the tree cannot create entries on its own; only the context menu does', () => {
    const tree = readSource('src/renderer/src/components/files/FileTree.tsx')
    const treeElement = tree.slice(tree.indexOf('<Tree<FileTreeNodeData>'), tree.indexOf('</Tree>'))
    assert.ok(treeElement.length > 0)
    // 没有 onCreate，Arborist 的 `a` / `Shift+A` 默认快捷键什么也不做。
    assert.doesNotMatch(treeElement, /onCreate=/u)
    assert.match(treeElement, /onRename=\{handleTreeRename\}/u)
    const panel = readSource('src/renderer/src/components/files/FilePanel.tsx')
    assert.doesNotMatch(panel, /\.create\(/u)
    assert.match(panel, /anchorEntry: contextMenu\.entry/u)

    // 这条前提写在 Arborist 里：两个快捷键都要先有 onCreate 才会动。升级时它变了，这里会先红。
    const container = readSource(
      'node_modules/react-arborist/dist/module/components/default-container.js'
    )
    assert.match(
      container,
      /e\.key === "a" && !e\.metaKey && !e\.ctrlKey && tree\.props\.onCreate/u
    )
    assert.match(container, /e\.key === "A"[\s\S]{0,80}if \(!tree\.props\.onCreate\)\s+return;/u)
  })

  void test('context-menu creation lands where the menu was opened, not at the selection', () => {
    assert.equal(resolveTreeCreateDirectoryPath(entry('.', 'directory')), '.')
    assert.equal(resolveTreeCreateDirectoryPath(entry('src', 'directory')), 'src')
    assert.equal(resolveTreeCreateDirectoryPath(entry('src/app.ts', 'file')), 'src')
    assert.equal(resolveTreeCreateDirectoryPath(entry('README.md', 'file')), '.')

    // 没有给父目录就是工程根目录（以前会退回到当前选中项所在的目录）。
    assert.equal(resolveTreeCreateParentPath(null), '.')
    assert.equal(resolveTreeCreateParentPath(entry('.', 'directory')), '.')
    assert.equal(resolveTreeCreateParentPath(entry('src/lib', 'directory')), 'src/lib')
    assert.equal(resolveTreeCreateParentPath(entry('src/lib/a.ts', 'file')), 'src/lib')
    const mutation = readSource('src/renderer/src/hooks/useWorkbenchMutationController.ts')
    assert.match(mutation, /parentPath: resolveTreeCreateParentPath\(parentEntry\)/u)
  })

  void test('default names skip the siblings of the target directory', () => {
    const childrenByPath = new Map([
      ['.', [entry('untitled.txt', 'file'), entry('new-folder', 'directory')]],
      ['src', [entry('src/untitled.txt', 'file'), entry('src/untitled-2.txt', 'file')]],
    ])
    assert.equal(getDefaultCreateName('file', '.', childrenByPath), 'untitled-2.txt')
    assert.equal(getDefaultCreateName('file', 'src', childrenByPath), 'untitled-3.txt')
    assert.equal(getDefaultCreateName('directory', '.', childrenByPath), 'new-folder-2')
    assert.equal(getDefaultCreateName('directory', 'docs', childrenByPath), 'new-folder')
  })

  void test('dropping onto the top level moves entries to the project root', () => {
    assert.equal(resolveTreeDropDirectoryPath(arboristRoot), '.')
    assert.equal(resolveTreeDropDirectoryPath(node('src', 'directory')), 'src')
    assert.equal(resolveTreeDropDirectoryPath(node('src/a.ts', 'file')), null)
    assert.equal(resolveTreeDropDirectoryPath(null), null)

    assert.equal(canDropTreeEntries(arboristRoot, [node('src/a.ts', 'file')]), true)
    assert.equal(canDropTreeEntries(arboristRoot, [node('src/lib', 'directory')]), true)
    assert.equal(canDropTreeEntries(node('docs', 'directory'), [node('src/a.ts', 'file')]), true)
    // 拖的里面有一项不在根目录，就还有东西要移。
    assert.equal(
      canDropTreeEntries(arboristRoot, [node('README.md', 'file'), node('src/a.ts', 'file')]),
      true
    )
  })

  void test('drops that would do nothing or break the tree are refused', () => {
    // 落在文件上。
    assert.equal(canDropTreeEntries(node('src/a.ts', 'file'), [node('b.ts', 'file')]), false)
    // 目录放进它自己或它的子目录。
    assert.equal(canDropTreeEntries(node('src', 'directory'), [node('src', 'directory')]), false)
    assert.equal(
      canDropTreeEntries(node('src/lib', 'directory'), [node('src', 'directory')]),
      false
    )
    // 本来就在那个目录里：放下什么也不会改变。
    assert.equal(canDropTreeEntries(arboristRoot, [node('README.md', 'file')]), false)
    assert.equal(canDropTreeEntries(node('src', 'directory'), [node('src/a.ts', 'file')]), false)
    assert.equal(canDropTreeEntries(arboristRoot, []), false)
    // 数据里没有条目的拖动节点（不是文件树的行）一律不接。
    assert.equal(canDropTreeEntries(arboristRoot, [arboristRoot]), false)
    // `src-old` 只是名字以 `src` 开头，不是 `src` 的子目录。
    assert.equal(canDropTreeEntries(node('src-old', 'directory'), [node('src', 'directory')]), true)
  })

  void test('moves skip entries that already sit in the target directory', () => {
    const moved = selectTreeEntriesToMove(
      [entry('README.md', 'file'), entry('src/a.ts', 'file'), entry('src', 'directory')],
      '.'
    )
    // `src/a.ts` 随 `src` 一起走；`README.md` 与 `src` 本来就在根目录。
    assert.deepEqual(moved.map((item) => item.path), [])
    assert.deepEqual(
      selectTreeEntriesToMove([entry('src/a.ts', 'file'), entry('docs/b.md', 'file')], 'docs').map(
        (item) => item.path
      ),
      ['src/a.ts']
    )
  })
})
