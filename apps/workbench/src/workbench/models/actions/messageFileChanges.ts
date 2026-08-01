import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type {
  ChatMessage,
  SystemFileChangePreviewResult,
  ToolCallBlock,
} from '../../contracts/index'

export interface MessageFileChangeDescriptor {
  changeId: string
  path: string
  created: boolean
  toolCallId: string
  preview?: SystemFileChangePreviewResult
}

function readChangeDescriptor(
  value: unknown,
  toolCallId: string
): MessageFileChangeDescriptor | null {
  const record = asRecord(value)
  const source = asRecord(record?.change) ?? record
  const changeId = source?.changeId
  const path = source?.path
  const created = source?.created

  if (typeof changeId !== 'string' || typeof path !== 'string' || typeof created !== 'boolean') return null

  return { changeId, path, created, toolCallId }
}

function readFirstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export function buildInlineWriteFileChangePreview(
  block: ToolCallBlock
): SystemFileChangePreviewResult | null {
  if (block.toolName !== 'write') return null

  const result = asRecord(block.result)
  const args = asRecord(block.args)
  if (!result || !args || result.changed === false) return null

  const path = readFirstStringValue(result.path, args.path)
  const content = args.content
  if (!path || typeof content !== 'string') return null

  const created = result.created === true
  const beforeContent = created
    ? ''
    : typeof result.beforeContent === 'string'
      ? result.beforeContent
      : null
  if (beforeContent === null) return null

  return {
    changeId: `inline:${block.toolCallId}:${path}`,
    path,
    created,
    rolledBack: false,
    revertAvailable: false,
    beforeContent,
    afterContent: content,
  }
}

function readFileChangeDescriptors(block: ToolCallBlock): MessageFileChangeDescriptor[] {
  const result = asRecord(block.result)
  if (!result) return []

  const descriptors: MessageFileChangeDescriptor[] = []
  const newRevisions = asRecord(result.newRevisions)
  const oldRevisions = asRecord(result.oldRevisions)
  const isCreatedPath = (path: string): boolean =>
    newRevisions?.[path] !== 'deleted' && oldRevisions !== null && oldRevisions[path] == null

  if (Array.isArray(result.transactions) && newRevisions) {
    for (const entry of result.transactions) {
      const transaction = asRecord(entry)
      const transactionId = transaction?.transactionId
      const changedFiles = transaction?.changedFiles
      if (typeof transactionId !== 'string' || !Array.isArray(changedFiles)) continue

      for (const path of changedFiles) {
        if (typeof path !== 'string') continue
        descriptors.push({
          changeId: transactionId,
          path,
          created: isCreatedPath(path),
          toolCallId: block.toolCallId,
        })
      }
    }
    if (descriptors.length > 0) return descriptors
  }

  const transactionId =
    typeof result.transactionId === 'string'
      ? result.transactionId
      : Array.isArray(result.transactionIds)
        ? result.transactionIds.find(
            (entry): entry is string => typeof entry === 'string' && !!entry.trim()
          )
        : undefined
  if (typeof transactionId === 'string' && Array.isArray(result.changedFiles) && newRevisions) {
    for (const path of result.changedFiles) {
      if (typeof path !== 'string') continue
      descriptors.push({
        changeId: transactionId,
        path,
        created: isCreatedPath(path),
        toolCallId: block.toolCallId,
      })
    }
    if (descriptors.length > 0) return descriptors
  }

  if (Array.isArray(result.fileChanges)) {
    for (const item of result.fileChanges) {
      const descriptor = readChangeDescriptor(item, block.toolCallId)
      if (descriptor) descriptors.push(descriptor)
    }
    if (descriptors.length > 0) return descriptors
  }

  const inlineWritePreview = buildInlineWriteFileChangePreview(block)
  if (inlineWritePreview) return [
      {
        changeId: inlineWritePreview.changeId,
        path: inlineWritePreview.path,
        created: inlineWritePreview.created,
        toolCallId: block.toolCallId,
        preview: inlineWritePreview,
      },
    ]

  const primaryDescriptor = readChangeDescriptor(result, block.toolCallId)
  if (primaryDescriptor) descriptors.push(primaryDescriptor)

  if (Array.isArray(result.files)) {
    for (const file of result.files) {
      const descriptor = readChangeDescriptor(file, block.toolCallId)
      if (descriptor) descriptors.push(descriptor)
    }
  }

  return descriptors
}

export function extractMessageFileChangeDescriptors(
  message: Pick<ChatMessage, 'blocks'>
): MessageFileChangeDescriptor[] {
  const descriptors = new Map<string, MessageFileChangeDescriptor>()

  for (const block of message.blocks) {
    if (block.type !== 'tool-call') continue

    for (const descriptor of readFileChangeDescriptors(block)) {
      const key = `${descriptor.changeId}\0${descriptor.path}`
      if (!descriptors.has(key)) descriptors.set(key, descriptor)
    }
  }

  return [...descriptors.values()]
}
