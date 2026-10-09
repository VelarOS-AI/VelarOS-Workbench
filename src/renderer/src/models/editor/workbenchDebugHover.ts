/**
 * 调试停着时，鼠标停在一个变量（或 `a.b.c` 这样的属性）上，在它上方显示此刻的值。
 *
 * 只认读起来没有副作用的写法：变量名、`this`、点号连起来的属性。求值交给调用方（在选中的那一帧里、不许有
 * 副作用），求不出来就不显示。类型提示那个悬浮框在下方，这个在上方，两个互不遮挡。
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { hoverTooltip } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

export interface WorkbenchDebugHoverOptions {
  /** 程序停着，而且选中的那一帧就在这个文件里：这时才去求值。 */
  isActive: () => boolean
  /** 在选中的那一帧里求值（不许有副作用）；求不出来为 null。 */
  evaluate: (expression: string) => Promise<Nullable<string>>
}

export interface WorkbenchDebugHoverExpression {
  from: number
  to: number
  expression: string
}

const MaxExpressionLength = 200
const SimpleNames = new Set(['VariableName', 'VariableDefinition', 'this'])

/** 这个节点读起来没有副作用：变量、`this`，或者对象同样简单的点号属性访问。 */
function isSimpleReference(node: SyntaxNode): boolean {
  if (SimpleNames.has(node.name)) return true
  if (node.name !== 'MemberExpression') return false

  const object = node.firstChild
  const property = node.lastChild
  // `a[b]`、`a.#b` 不算：下标里可以是任意表达式。
  return !!object && property?.name === 'PropertyName' && isSimpleReference(object)
}

/** 鼠标所在位置上能求值的那一段；不是变量或简单的属性访问为 null。 */
export function findWorkbenchDebugHoverExpression(
  state: EditorState,
  position: number
): Nullable<WorkbenchDebugHoverExpression> {
  // 新打开的文件可能只解析了首屏，悬浮查询使用补齐到当前行的树。
  const tree = ensureSyntaxTree(state, state.doc.lineAt(position).to) ?? syntaxTree(state)
  // 鼠标落在标识符的末尾时，右边是别的节点：左右各看一次。
  const node = [tree.resolveInner(position, 1), tree.resolveInner(position, -1)].find(
    (candidate) => SimpleNames.has(candidate.name) || candidate.name === 'PropertyName'
  )
  if (!node) return null

  let target: SyntaxNode = node
  if (node.name === 'PropertyName') {
    // `a.b.c` 里停在 `b` 上：求的是 `a.b`（到它自己为止）。对象字面量、类里的属性名不是访问。
    const member = node.parent
    if (member?.name !== 'MemberExpression' || member.lastChild?.from !== node.from) return null
    target = member
  }
  if (!isSimpleReference(target)) return null

  const expression = state.sliceDoc(target.from, node.to)
  if (!expression || expression.length > MaxExpressionLength) return null
  return { from: node.from, to: node.to, expression }
}

export function createWorkbenchDebugHoverExtension(options: WorkbenchDebugHoverOptions): Extension {
  return hoverTooltip(
    async (view, position) => {
      if (!options.isActive()) return null
      const found = findWorkbenchDebugHoverExpression(view.state, position)
      if (!found) return null

      const document = view.state.doc
      const value = await options.evaluate(found.expression)
      // 等结果的工夫文档变了、程序又跑起来了：这个值已经不算数。
      if (value === null || view.state.doc !== document || !options.isActive()) return null

      return {
        pos: found.from,
        end: found.to,
        above: true,
        create: () => {
          const dom = view.dom.ownerDocument.createElement('div')
          dom.className = 'cm-workbenchDebugHover'
          const name = dom.appendChild(view.dom.ownerDocument.createElement('span'))
          name.className = 'cm-workbenchDebugHoverName'
          name.textContent = found.expression
          dom.append(' = ')
          const text = dom.appendChild(view.dom.ownerDocument.createElement('span'))
          text.className = 'cm-workbenchDebugHoverValue'
          text.textContent = value
          return { dom }
        },
      }
    },
    { hideOnChange: true }
  )
}
