import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeSessionBinding } from '@velaros-ai/velaros'
import { isNonBlankString, isPlainObject } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { writeFileOnceSync } from '@velaros-ai/velaros/core/utils/FilePersistence'

export const WorkbenchConversationBindingFileName = 'execution-binding.json'
export const WorkbenchConversationContextFileName = 'context.sqlite'

/** Workbench 核验过的执行归属；独立于 Platform 的私有会话记录。 */
export interface WorkbenchConversationExecutionReceipt {
  readonly version: 1
  readonly projectRoot: string
  readonly sessionId: string
  readonly sandbox: boolean
  readonly binding: RuntimeSessionBinding
}

interface WorkbenchConversationExecutionLocation {
  readonly dataDir: string
  readonly projectRoot: string
  readonly sessionId: string
}

interface WorkbenchConversationExecutionOptions extends WorkbenchConversationExecutionLocation {
  readonly sandbox: boolean
  readonly binding: RuntimeSessionBinding
}

/** 首次绑定只发布一次；重开必须沿用完全相同的产品执行边界。 */
export async function bindWorkbenchConversationExecution(
  options: WorkbenchConversationExecutionOptions
): Promise<WorkbenchConversationExecutionReceipt> {
  const receipt = parseReceipt({
    version: 1,
    projectRoot: await realpath(options.projectRoot),
    sessionId: options.sessionId,
    sandbox: options.sandbox,
    binding: options.binding,
  })
  try {
    return requireSameReceipt(await readReceipt(options.dataDir, receipt), receipt)
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error
  }

  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const published = writeFileOnceSync(
    join(options.dataDir, WorkbenchConversationBindingFileName),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 }
  )
  return published
    ? receipt
    : requireSameReceipt(await readReceipt(options.dataDir, receipt), receipt)
}

/** 空闲控制只读产品凭据；不存在与未知存储明确区分，不补写任何记录。 */
export async function readWorkbenchConversationExecution(
  options: WorkbenchConversationExecutionLocation
): Promise<WorkbenchConversationExecutionReceipt> {
  return readReceipt(options.dataDir, {
    projectRoot: await realpath(options.projectRoot),
    sessionId: options.sessionId,
  })
}

async function readReceipt(
  dataDir: string,
  owner: Pick<WorkbenchConversationExecutionReceipt, 'projectRoot' | 'sessionId'>
): Promise<WorkbenchConversationExecutionReceipt> {
  const path = join(dataDir, WorkbenchConversationBindingFileName)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (
      (await entryExists(path)) ||
      (await entryExists(join(dataDir, WorkbenchConversationContextFileName)))
    )
      throw new AppError('CONFLICT', '会话存储已存在，但缺少可读取的 Workbench 执行凭据。')
    throw new AppError('NOT_FOUND', '尚未绑定此 Workbench 会话的执行边界。', error)
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new AppError('CONFLICT', 'Workbench 会话执行凭据已损坏。', error)
  }
  const receipt = parseReceipt(value)
  if (receipt.projectRoot !== owner.projectRoot || receipt.sessionId !== owner.sessionId)
    throw new AppError('CONFLICT', 'Workbench 会话执行凭据不属于当前项目或会话。')
  return receipt
}

function parseReceipt(value: unknown): WorkbenchConversationExecutionReceipt {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    !isNonBlankString(value.projectRoot) ||
    !isNonBlankString(value.sessionId) ||
    typeof value.sandbox !== 'boolean' ||
    !isPlainObject(value.binding) ||
    Object.keys(value.binding).length !== 2 ||
    !isNonBlankString(value.binding.executionIdentity) ||
    !isNonBlankString(value.binding.authorizationScope)
  )
    throw new AppError('CONFLICT', 'Workbench 会话执行凭据格式无效。')
  return Object.freeze({
    version: 1,
    projectRoot: value.projectRoot,
    sessionId: value.sessionId,
    sandbox: value.sandbox,
    binding: Object.freeze({
      executionIdentity: value.binding.executionIdentity,
      authorizationScope: value.binding.authorizationScope,
    }),
  })
}

function requireSameReceipt(
  current: WorkbenchConversationExecutionReceipt,
  expected: WorkbenchConversationExecutionReceipt
): WorkbenchConversationExecutionReceipt {
  if (
    current.projectRoot !== expected.projectRoot ||
    current.sessionId !== expected.sessionId ||
    current.sandbox !== expected.sandbox ||
    current.binding.executionIdentity !== expected.binding.executionIdentity ||
    current.binding.authorizationScope !== expected.binding.authorizationScope
  )
    throw new AppError('CONFLICT', 'Workbench 会话的执行身份或授权范围已改变，请新建会话。')
  return current
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
