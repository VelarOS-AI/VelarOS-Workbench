import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  canExpandWorkbenchCallHierarchyNode,
  createWorkbenchCallHierarchy,
  failWorkbenchCallHierarchyNode,
  listWorkbenchCallHierarchyRows,
  moveInWorkbenchCallHierarchy,
  resolveWorkbenchCallHierarchyTarget,
  setWorkbenchCallHierarchyChildren,
  toggleWorkbenchCallHierarchyNode,
  type WorkbenchCallHierarchyState,
} from '../src/renderer/src/models/editor/workbenchCallHierarchy'
import { isWorkbenchEditorNavigationCommand } from '../src/renderer/src/models/editor/workbenchEditorCommands'
// 这个键现在在编辑器命令的键位表里；下面查的是 Workbench 方案（不给方案时的默认）。
import { resolveWorkbenchEditorKeymapCommand as resolveWorkbenchEditorCommandFromKey } from '../src/renderer/src/models/editor/workbenchEditorKeymapResolver'
import { type WorkbenchLanguageServiceCallHierarchyCall, type WorkbenchLanguageServiceCallHierarchyItem } from '../src/shared/contracts/workbench'

function item(name: string, path: string, line: number): WorkbenchLanguageServiceCallHierarchyItem {
  return { name, kind: 'function', path, line, column: 17 }
}

function call(name: string, path: string, line: number, siteLines: number[]): WorkbenchLanguageServiceCallHierarchyCall {
  return {
    item: item(name, path, line),
    sites: siteLines.map((siteLine) => ({ path, line: siteLine, column: 5, preview: `${name}()` })),
  }
}

const Add = item('add', 'src/math.ts', 1)

/** 树的样子：每行「缩进 +/-/· 名字」，正在问的带 …，问不到的带原因。 */
function draw(state: WorkbenchCallHierarchyState): string[] {
  return listWorkbenchCallHierarchyRows(state).map((node) => {
    const twisty = !canExpandWorkbenchCallHierarchyNode(node) ? '·' : node.expanded ? '-' : '+'
    const suffix = node.loading ? ' …' : node.error ? ` !${node.error}` : node.recursive ? ' ↻' : ''
    return `${'  '.repeat(node.depth)}${twisty} ${node.item.name}${suffix}`
  })
}

/** 根是 add，第一层已经问到：sum 与 area。 */
function opened(): WorkbenchCallHierarchyState {
  const state = createWorkbenchCallHierarchy(Add, 'incoming')
  return setWorkbenchCallHierarchyChildren(state, state.rootId, [
    call('sum', 'src/math.ts', 5, [6]),
    call('area', 'src/shapes.ts', 5, [6, 6]),
  ])
}

void describe('call hierarchy tree', () => {
  void test('opens on the function with its first level, the rest is asked level by level', () => {
    const loading = createWorkbenchCallHierarchy(Add, 'incoming')
    assert.deepEqual(draw(loading), ['- add …'])

    const state = opened()
    assert.deepEqual(draw(state), ['- add', '  + sum', '  + area'])

    // 第一次展开：下一层还没问过，去问；答复回来挂上。
    const areaId = listWorkbenchCallHierarchyRows(state)[2]!.id
    const expanding = toggleWorkbenchCallHierarchyNode(state, areaId)
    assert.equal(expanding.load, true)
    assert.deepEqual(draw(expanding.state), ['- add', '  + sum', '  - area …'])
    // 还在问的时候再点一下不重复问。
    assert.equal(toggleWorkbenchCallHierarchyNode(expanding.state, areaId).load, false)

    const loaded = setWorkbenchCallHierarchyChildren(expanding.state, areaId, [
      call('total', 'src/shapes.ts', 8, [9]),
    ])
    assert.deepEqual(draw(loaded), ['- add', '  + sum', '  - area', '    + total'])

    // 再点是收起、展开，不再问。
    const collapsed = toggleWorkbenchCallHierarchyNode(loaded, areaId)
    assert.equal(collapsed.load, false)
    assert.deepEqual(draw(collapsed.state), ['- add', '  + sum', '  + area'])
    const reopened = toggleWorkbenchCallHierarchyNode(collapsed.state, areaId)
    assert.equal(reopened.load, false)
    assert.deepEqual(draw(reopened.state), ['- add', '  + sum', '  - area', '    + total'])
  })

  void test('a function nobody calls is a leaf; a failed level can be asked again', () => {
    const state = opened()
    const sumId = listWorkbenchCallHierarchyRows(state)[1]!.id
    const expanding = toggleWorkbenchCallHierarchyNode(state, sumId).state
    const empty = setWorkbenchCallHierarchyChildren(expanding, sumId, [])
    assert.deepEqual(draw(empty), ['- add', '  · sum', '  + area'])

    const failed = failWorkbenchCallHierarchyNode(expanding, sumId, 'timed out')
    assert.deepEqual(draw(failed), ['- add', '  + sum !timed out', '  + area'])
    const retry = toggleWorkbenchCallHierarchyNode(failed, sumId)
    assert.equal(retry.load, true)
    assert.deepEqual(draw(retry.state), ['- add', '  - sum …', '  + area'])
  })

  void test('recursion ends the branch instead of unfolding forever', () => {
    const state = opened()
    const areaId = listWorkbenchCallHierarchyRows(state)[2]!.id
    const expanding = toggleWorkbenchCallHierarchyNode(state, areaId).state
    // area 被 add 调用：add 在这一支上面已经有了。
    const loaded = setWorkbenchCallHierarchyChildren(expanding, areaId, [
      call('add', 'src/math.ts', 1, [2]),
      call('area', 'src/shapes.ts', 5, [7]),
      call('total', 'src/shapes.ts', 8, [9]),
    ])
    assert.deepEqual(draw(loaded), ['- add', '  + sum', '  - area', '    · add ↻', '    · area ↻', '    + total'])
    const recursiveId = listWorkbenchCallHierarchyRows(loaded)[3]!.id
    assert.deepEqual(toggleWorkbenchCallHierarchyNode(loaded, recursiveId), { state: loaded, load: false })
  })

  void test('an answer for a tree that was replaced is ignored', () => {
    const state = opened()
    const areaId = listWorkbenchCallHierarchyRows(state)[2]!.id
    // 没在等答复的节点（已经问到了、或者根本没发起）不接。
    assert.equal(setWorkbenchCallHierarchyChildren(state, areaId, [call('x', 'src/x.ts', 1, [2])]), state)
    assert.equal(setWorkbenchCallHierarchyChildren(state, 'root/9', []), state)
    assert.equal(failWorkbenchCallHierarchyNode(state, areaId, 'late'), state)
  })

  void test('clicking a caller goes to the call; clicking a callee goes to the function', () => {
    const incoming = opened()
    const [root, , area] = listWorkbenchCallHierarchyRows(incoming)
    assert.deepEqual(resolveWorkbenchCallHierarchyTarget(incoming, root!), {
      path: 'src/math.ts',
      line: 1,
      column: 17,
    })
    // 调用方：它里面发起调用的第一处。
    assert.deepEqual(resolveWorkbenchCallHierarchyTarget(incoming, area!), {
      path: 'src/shapes.ts',
      line: 6,
      column: 5,
    })

    const outgoingRoot = createWorkbenchCallHierarchy(item('total', 'src/shapes.ts', 8), 'outgoing')
    const outgoing = setWorkbenchCallHierarchyChildren(outgoingRoot, outgoingRoot.rootId, [
      // 调用处在 total 自己的文件里；被调用的 sum 在另一个文件。
      { item: item('sum', 'src/math.ts', 5), sites: [{ path: 'src/shapes.ts', line: 9, column: 12 }] },
    ])
    const callee = listWorkbenchCallHierarchyRows(outgoing)[1]!
    assert.deepEqual(resolveWorkbenchCallHierarchyTarget(outgoing, callee), {
      path: 'src/math.ts',
      line: 5,
      column: 17,
    })
  })

  void test('arrow keys walk the tree: right opens or steps in, left closes or steps out', () => {
    const state = opened()
    const rows = listWorkbenchCallHierarchyRows(state)
    const [root, sum, area] = rows
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 0, 'ArrowDown'), { index: 1 })
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 2, 'ArrowDown'), null)
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 1, 'ArrowUp'), { index: 0 })
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 0, 'ArrowUp'), null)

    // 根展开着：右键进到第一个下一层，左键收起它。
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 0, 'ArrowRight'), { index: 1 })
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 0, 'ArrowLeft'), { toggle: root!.id })
    // 收着的节点：右键展开，左键回到上一层。
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 1, 'ArrowRight'), { toggle: sum!.id })
    assert.deepEqual(moveInWorkbenchCallHierarchy(rows, 2, 'ArrowLeft'), { index: 0 })

    // 叶子（问过了没有下一层）：右键不动。
    const expanding = toggleWorkbenchCallHierarchyNode(state, area!.id).state
    const leaf = setWorkbenchCallHierarchyChildren(expanding, area!.id, [])
    assert.deepEqual(moveInWorkbenchCallHierarchy(listWorkbenchCallHierarchyRows(leaf), 2, 'ArrowRight'), null)
    assert.deepEqual(moveInWorkbenchCallHierarchy([], 0, 'ArrowDown'), null)
  })
})

void describe('call hierarchy key', () => {
  const key = (code: string, value: string, modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }) => ({
    code,
    key: value,
    altKey: !!modifiers.alt,
    ctrlKey: !!modifiers.ctrl,
    metaKey: !!modifiers.meta,
    shiftKey: !!modifiers.shift,
  })

  void test('Ctrl+Alt+H on every platform, by key position', () => {
    // macOS 上 ⌃⌥H 打出来的不是 h：按键位认。
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyH', '˙', { ctrl: true, alt: true }), 'MacIntel'),
      'call-hierarchy'
    )
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyH', 'h', { ctrl: true, alt: true }), 'Linux x86_64'),
      'call-hierarchy'
    )
    assert.equal(resolveWorkbenchEditorCommandFromKey(key('KeyH', 'h', { ctrl: true }), 'MacIntel'), null)
    assert.equal(
      resolveWorkbenchEditorCommandFromKey(key('KeyH', 'h', { meta: true, alt: true }), 'MacIntel'),
      null
    )
    assert.equal(isWorkbenchEditorNavigationCommand('call-hierarchy'), true)
  })
})
