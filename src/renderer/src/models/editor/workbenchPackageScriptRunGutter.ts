import { jsonLanguage } from '@codemirror/lang-json'
import type { Extension } from '@codemirror/state'

import { isString, toNullable } from '@velaros-ai/velaros/core'

import type { WorkbenchRunSessionLaunchOptions } from '../commands/workbenchCommandLines'
import {
  buildWorkbenchPackageScriptRunCommand,
  type PackageManagerCommand,
} from '../commands/workbenchPackageScriptCommand'

import {
  createWorkbenchRunGutterExtension,
  type WorkbenchRunGutterAction,
} from './workbenchRunGutter'

export type WorkbenchPackageScriptRunAction = WorkbenchRunGutterAction

interface JsonNodeSnapshot {
  name: string
  from: number
  to: number
  children: JsonNodeSnapshot[]
}

interface WorkbenchPackageScriptRunGutterOptions {
  content: string
  packageManager: PackageManagerCommand
  path: Nullable<string>
}

interface WorkbenchPackageScriptRunExtensionOptions extends WorkbenchPackageScriptRunGutterOptions {
  disabled?: boolean
  onRunScript: (command: string, launch?: WorkbenchRunSessionLaunchOptions) => void
}

function snapshotJsonTree(content: string): JsonNodeSnapshot {
  const tree = jsonLanguage.parser.parse(content)
  const cursor = tree.cursor()

  function snapshotCurrent(): JsonNodeSnapshot {
    const node: JsonNodeSnapshot = {
      name: cursor.name,
      from: cursor.from,
      to: cursor.to,
      children: [],
    }

    if (cursor.firstChild()) {
      do {
        node.children.push(snapshotCurrent())
      } while (cursor.nextSibling())
      cursor.parent()
    }

    return node
  }

  return snapshotCurrent()
}

function parseJsonStringLiteral(content: string, node: JsonNodeSnapshot): Nullable<string> {
  try {
    const value = JSON.parse(content.slice(node.from, node.to)) as unknown
    return isString(value) ? value : null
    // @arch-guard:suspend velaros/code-style/require-error-logging 理由：编辑中的 JSON 属性名可能临时不完整，此处返回 null 让上层自然忽略，避免输入时刷日志。
  } catch {
    return null
  }
}

function getJsonPropertyName(content: string, property: JsonNodeSnapshot): Nullable<string> {
  const nameNode = property.children.find((child) => child.name === 'PropertyName')
  return nameNode ? parseJsonStringLiteral(content, nameNode) : null
}

function getJsonPropertyValue(property: JsonNodeSnapshot): Nullable<JsonNodeSnapshot> {
  return toNullable(
    property.children.find((child) => child.name !== 'PropertyName' && child.name !== ':')
  )
}

function findRootObject(root: JsonNodeSnapshot): Nullable<JsonNodeSnapshot> {
  if (root.name === 'Object') return root
  return toNullable(root.children.find((child) => child.name === 'Object'))
}

function findScriptsObject(root: JsonNodeSnapshot, content: string): Nullable<JsonNodeSnapshot> {
  const rootObject = findRootObject(root)
  if (!rootObject) return null

  for (const property of rootObject.children) {
    if (property.name !== 'Property') continue
    if (getJsonPropertyName(content, property) !== 'scripts') continue

    const value = getJsonPropertyValue(property)
    return value?.name === 'Object' ? value : null
  }

  return null
}

function buildLineResolver(content: string): (offset: number) => number {
  const lineStarts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      lineStarts.push(index + 1)
    }
  }

  return (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const start = lineStarts[middle] ?? 0
      const nextStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY
      if (offset < start) {
        high = middle - 1
      } else if (offset >= nextStart) {
        low = middle + 1
      } else {
        return middle + 1
      }
    }
    return lineStarts.length
  }
}

export function shouldShowWorkbenchPackageScriptRunGutter(path: Nullable<string>): boolean {
  const normalized = path?.replace(/\\/g, '/').replace(/^\.\/+/, '')
  return normalized === 'package.json' || !!normalized?.endsWith('/package.json')
}

export function buildWorkbenchPackageScriptRunActions({
  content,
  packageManager,
  path,
}: WorkbenchPackageScriptRunGutterOptions): WorkbenchPackageScriptRunAction[] {
  if (!shouldShowWorkbenchPackageScriptRunGutter(path)) return []

  const packageJsonPath = path ?? 'package.json'
  const root = snapshotJsonTree(content)
  const scriptsObject = findScriptsObject(root, content)
  if (!scriptsObject) return []

  const lineForOffset = buildLineResolver(content)
  const actions: WorkbenchPackageScriptRunAction[] = []
  for (const property of scriptsObject.children) {
    if (property.name !== 'Property') continue

    const name = getJsonPropertyName(content, property)
    const value = getJsonPropertyValue(property)
    if (!name || value?.name !== 'String') continue

    actions.push({
      ...buildWorkbenchPackageScriptRunCommand({
        packageJsonPath,
        packageManager,
        scriptName: name,
      }),
      label: name,
      line: lineForOffset(property.from),
    })
  }

  return actions
}

export function createWorkbenchPackageScriptRunGutterExtension({
  content,
  disabled = false,
  onRunScript,
  packageManager,
  path,
}: WorkbenchPackageScriptRunExtensionOptions): Extension {
  const actions = buildWorkbenchPackageScriptRunActions({ content, packageManager, path })
  return createWorkbenchRunGutterExtension({
    actions,
    disabled,
    onRun: onRunScript,
  })
}
