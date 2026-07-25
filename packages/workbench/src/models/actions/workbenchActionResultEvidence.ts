import { isBlank, isEmpty, isNonBlankString, isPresent, Log, toNullable } from '@velaros/core'
import { hasToolActivityKind } from '@velaros/core/constants/toolMetadataCatalog'
import type { ChatMessage, ContentBlock, ToolCallBlock } from '@velaros/core/types'
import { extractMessageFileChangeDescriptors } from '@velaros/core/utils/messageFileChanges'
import {
  asRecord,
  readBoolean,
  readFirstString,
  readNumber,
  readRecordsArray,
  readString,
} from '@velaros/core/utils/unknownJsonRecord'

const LEGACY_COMMAND_TOOL_NAMES = new Set(['run_command'])
const RESULT_SUMMARY_LIMIT = 180
const RESULT_DETAILS_LIMIT = 1200
const VERIFICATION_SUMMARY_LIMIT = 500
const MAX_CHANGED_FILES = 8
const log = Log.tag('workbench-action-result-evidence')

function isWorkbenchCommandToolName(toolName: string): boolean {
  return hasToolActivityKind(toolName, 'command') || LEGACY_COMMAND_TOOL_NAMES.has(toolName)
}

export interface WorkbenchActionRunVerificationEvidence {
  command: Nullable<string>
  success: Nullable<boolean>
  exitCode: Nullable<number>
  summary: Nullable<string>
}

export interface WorkbenchActionRunResultEvidence {
  resultSummary: Nullable<string>
  resultDetails: Nullable<string>
  changedFiles: string[]
  verificationEvidence: Nullable<WorkbenchActionRunVerificationEvidence>
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed

  return `${trimmed.slice(0, limit)}...`
}

function tail(value: string, limit: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= limit) return trimmed

  return `...${trimmed.slice(trimmed.length - limit)}`
}

function extractMessageText(message: ChatMessage | undefined): string {
  if (!message) return ''

  return message.blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trimEnd())
    .filter((text) => !isBlank(text.trim()))
    .join('\n\n')
    .trim()
}

function readResultRecord(block: ToolCallBlock): Nullable<Record<string, any>> {
  const result = asRecord(block.result)
  if (result) return result

  if (!isNonBlankString(block.serializedResult)) return null

  try {
    return asRecord(JSON.parse(block.serializedResult))
  } catch (error) {
    log.debug('解析 action 工具结果失败，跳过结构化证据', {
      error: String(error),
    })
    return null
  }
}

function readCommand(
  block: ToolCallBlock,
  result: Nullable<Record<string, any>>
): Nullable<string> {
  const args = asRecord(block.args)
  return readFirstString(result?.command, result?.cmd, args?.command, args?.cmd)
}

function readCommandOutputSummary(
  block: ToolCallBlock,
  result: Nullable<Record<string, any>>
): Nullable<string> {
  const stderr = readString(result, 'stderr')
  const stdout = readString(result, 'stdout')
  const message = readString(result, 'message')
  const error = block.error?.trim() || null
  const parts = [
    stderr ? `stderr: ${tail(stderr, VERIFICATION_SUMMARY_LIMIT)}` : null,
    stdout ? `stdout: ${tail(stdout, VERIFICATION_SUMMARY_LIMIT)}` : null,
    message,
    error,
  ].filter((part): part is string => !!part)

  if (isEmpty(parts)) return null

  return truncate(parts.join('\n'), VERIFICATION_SUMMARY_LIMIT)
}

function buildCommandEvidence(
  block: ToolCallBlock
): Nullable<WorkbenchActionRunVerificationEvidence> {
  const result = readResultRecord(block)
  if (!isWorkbenchCommandToolName(block.toolName)) return null

  const exitCode = readNumber(result, 'exitCode')
  const success = readBoolean(result, 'success') ?? (!isPresent(exitCode) ? null : exitCode === 0)

  return {
    command: readCommand(block, result),
    success,
    exitCode,
    summary: readCommandOutputSummary(block, result),
  }
}

function readStepCommand(step: Record<string, any>): Nullable<string> {
  const result = asRecord(step.result)
  const suggestion = asRecord(step.suggestion)
  return readFirstString(suggestion?.command, result?.command, step?.command)
}

function readStepResult(step: Record<string, any>): Nullable<Record<string, any>> {
  return asRecord(step.result) ?? step
}

function buildVerificationPlanEvidence(
  block: ToolCallBlock
): Nullable<WorkbenchActionRunVerificationEvidence> {
  if (block.toolName !== 'run_verification_plan') return null

  const result = readResultRecord(block)
  const steps = readRecordsArray(result, 'steps')
  const lastStep = toNullable(steps[steps.length - 1])
  const lastStepResult = lastStep ? readStepResult(lastStep) : null
  const overallStatus = readString(result, 'overallStatus')
  const explicitSuccess = readBoolean(result, 'success')
  const stepSuccess =
    steps.length > 0 ? steps.every((step) => !!readBoolean(readStepResult(step), 'success')) : null
  const success =
    explicitSuccess ??
    (overallStatus === 'passed'
      ? true
      : overallStatus === 'failed' || overallStatus === 'timed-out'
        ? false
        : stepSuccess)
  const summaryParts = [
    overallStatus ? `overall: ${overallStatus}` : null,
    readCommandOutputSummary(block, lastStepResult),
  ].filter((part): part is string => !!part)

  return {
    command: lastStep ? readStepCommand(lastStep) : readCommand(block, result),
    success,
    exitCode: readNumber(lastStepResult, 'exitCode'),
    summary: !isEmpty(summaryParts)
      ? truncate(summaryParts.join('\n'), VERIFICATION_SUMMARY_LIMIT)
      : null,
  }
}

function buildVerificationEvidence(
  message: ChatMessage | undefined
): Nullable<WorkbenchActionRunVerificationEvidence> {
  if (!message) return null

  for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
    const block = message.blocks[index]
    if (block?.type !== 'tool-call') continue

    const verificationPlanEvidence = buildVerificationPlanEvidence(block)
    if (verificationPlanEvidence) return verificationPlanEvidence

    const commandEvidence = buildCommandEvidence(block)
    if (commandEvidence) return commandEvidence
  }

  return null
}

function buildChangedFiles(message: ChatMessage | undefined): string[] {
  if (!message) return []

  return [
    ...new Set(
      extractMessageFileChangeDescriptors(message)
        .map((descriptor) => descriptor.path.trim())
        .filter((path) => path.length > 0)
    ),
  ].slice(0, MAX_CHANGED_FILES)
}

export function buildWorkbenchActionRunResultEvidence(
  message: ChatMessage | undefined,
  fallbackError?: LooseOptional<string>
): WorkbenchActionRunResultEvidence {
  const text = extractMessageText(message)
  const fallback = fallbackError?.trim() || ''
  const details = text || fallback
  const summarySource = normalizeText(text || fallback)

  return {
    resultSummary: summarySource ? truncate(summarySource, RESULT_SUMMARY_LIMIT) : null,
    resultDetails: details ? truncate(details, RESULT_DETAILS_LIMIT) : null,
    changedFiles: buildChangedFiles(message),
    verificationEvidence: buildVerificationEvidence(message),
  }
}
