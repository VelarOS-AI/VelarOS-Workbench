/**
 * 检查器给的值（`Runtime.RemoteObject`）变成给界面看的一行文字。规矩与浏览器的开发者工具差不多：字符串带引号，
 * 数组、普通对象带一段简短的预览，函数只留签名，其它对象用它自己的描述（`Map(2)`、`Error: …` 的第一行）。
 */
import type {
  WorkbenchDebuggerValue,
  WorkbenchDebuggerValueType,
  WorkbenchDebuggerVariable,
} from '../../../shared/workbenchDebugger'

interface InspectorPropertyPreview {
  name: string
  type: string
  value?: string
  subtype?: string
}

interface InspectorEntryPreview {
  key?: InspectorObjectPreview
  value: InspectorObjectPreview
}

interface InspectorObjectPreview {
  type: string
  subtype?: string
  description?: string
  overflow?: boolean
  properties?: InspectorPropertyPreview[]
  entries?: InspectorEntryPreview[]
}

/** `Runtime.RemoteObject` 里用得到的字段。 */
export interface InspectorRemoteObject {
  type: string
  subtype?: string
  className?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
  preview?: InspectorObjectPreview
}

/** `Runtime.PropertyDescriptor` / `InternalPropertyDescriptor` / `PrivatePropertyDescriptor` 里用得到的字段。 */
export interface InspectorPropertyDescriptor {
  name: string
  value?: InspectorRemoteObject
  get?: InspectorRemoteObject
  set?: InspectorRemoteObject
}

const MaxTextLength = 240
const MaxPreviewLength = 120
const ArrayLikeSubtypes = new Set(['array', 'typedarray'])
const SelfDescribingSubtypes = new Set(['date', 'regexp', 'promise', 'proxy', 'weakmap', 'weakset'])

function clip(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/** 函数只留签名：`ƒ add(a, b)`、`class Widget`。 */
function describeFunction(description: string): string {
  if (description.startsWith('class ')) return clip(description.split(/\s*[{\n]/u, 1)[0]!, 80)

  const signature = /^(?:async\s+)?(?:function\s*\*?\s*)?([\w$]*)\s*(\([^)]*\))/u.exec(description)
  return signature ? `ƒ ${signature[1]}${signature[2]}` : clip(`ƒ ${description}`, 80)
}

function describePreviewProperty(property: InspectorPropertyPreview): string {
  if (property.type === 'string') return JSON.stringify(property.value ?? '')
  if (property.type === 'function') return 'ƒ'
  if (property.type === 'undefined') return 'undefined'
  if (property.subtype === 'null') return 'null'
  // 嵌套的普通对象不再往里展开，只示意它是个对象。
  if (property.type === 'object' && property.value === 'Object') return '{…}'
  return property.value ?? property.type
}

function describeEntry(entry: InspectorEntryPreview): string {
  const value = describePreview(entry.value)
  return entry.key ? `${describePreview(entry.key)} => ${value}` : value
}

function describePreview(preview: InspectorObjectPreview): string {
  if (preview.type === 'string') return JSON.stringify(preview.description ?? '')
  return preview.description ?? preview.type
}

/** 对象的简短预览：数组 `[1, 2, 3]`，其它 `{a: 1, b: "x"}`；Map / Set 列它的项。 */
function describeObjectPreview(preview: InspectorObjectPreview, arrayLike: boolean): string {
  const items = preview.entries?.length
    ? preview.entries.map(describeEntry)
    : (preview.properties ?? []).map((property) =>
        arrayLike ? describePreviewProperty(property) : `${property.name}: ${describePreviewProperty(property)}`
      )
  if (preview.overflow) items.push('…')
  const body = clip(items.join(', '), MaxPreviewLength)
  return arrayLike ? `[${body}]` : `{${body}}`
}

function describeObject(object: InspectorRemoteObject): string {
  const description = object.description ?? object.className ?? 'Object'
  // 错误对象的描述是整段调用栈：只留第一行。
  if (object.subtype === 'error') return clip(description.split('\n', 1)[0]!, MaxTextLength)
  if (!object.preview || SelfDescribingSubtypes.has(object.subtype ?? '')) return description

  const arrayLike = ArrayLikeSubtypes.has(object.subtype ?? '')
  const preview = describeObjectPreview(object.preview, arrayLike)
  // 普通对象只写预览；数组、Map、类的实例前面带上它是什么（`Array(3)`、`Map(2)`、`Widget`）。
  return description === 'Object' ? preview : `${description} ${preview}`
}

export function toWorkbenchDebuggerValue(object: InspectorRemoteObject): WorkbenchDebuggerValue {
  const primitive = (type: WorkbenchDebuggerValueType, text: string): WorkbenchDebuggerValue => ({
    type,
    text: clip(text, MaxTextLength),
    objectId: null,
  })

  switch (object.type) {
    case 'undefined':
      return primitive('undefined', 'undefined')
    case 'string':
      return primitive('string', JSON.stringify(String(object.value ?? '')))
    case 'number':
      // NaN、Infinity、-0 没法放进 JSON，检查器写在 unserializableValue 里。
      return primitive('number', object.unserializableValue ?? String(object.value))
    case 'boolean':
      return primitive('boolean', String(object.value))
    case 'bigint':
      return primitive('bigint', object.unserializableValue ?? object.description ?? '')
    case 'symbol':
      return primitive('symbol', object.description ?? 'Symbol()')
    case 'function':
      return {
        type: 'function',
        text: describeFunction(object.description ?? ''),
        objectId: object.objectId ?? null,
      }
    default:
      if (object.subtype === 'null') return primitive('null', 'null')
      return {
        type: 'object',
        text: clip(describeObject(object), MaxTextLength),
        objectId: object.objectId ?? null,
      }
  }
}

/**
 * 一个属性：有值的照值写。只有访问器（getter / setter）的不去调它，标成访问器；两样都没有的是还没初始化的
 * `let` / `const`（执行还没走到它的声明）。
 */
export function toWorkbenchDebuggerVariable(
  descriptor: InspectorPropertyDescriptor
): WorkbenchDebuggerVariable {
  return {
    name: descriptor.name,
    value: descriptor.value
      ? toWorkbenchDebuggerValue(descriptor.value)
      : {
          type: descriptor.get || descriptor.set ? 'accessor' : 'unavailable',
          text: '',
          objectId: null,
        },
  }
}
