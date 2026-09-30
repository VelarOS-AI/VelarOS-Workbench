/**
 * 项目工作区 IPC 边界公用件：跨进程错误信封 + 边界外来数据的原语解析。
 *
 * IPC 入参是边界外来数据，在各注册器里解析一次（形状不符按无效请求处理），服务内部只见
 * 类型；任何异常在此降为错误信封（保留 AppError 语义码），renderer 侧再升回 Result。
 * 文件系统面（WorkbenchFsIpc）与语言智能面（WorkbenchLanguageServiceIpc）共用同一套边界纪律。
 */
import { AppError, type ErrorCode } from '@velaros-ai/core/error'

import type { WorkbenchFsCallResult } from '../../shared/workbenchFs'

export function invalidRequest(): never {
  throw new AppError('VALIDATION', '无效的工作区请求。')
}

export async function callWithEnvelope<TValue>(
  call: () => Promise<TValue>
): Promise<WorkbenchFsCallResult<TValue>> {
  try {
    return { ok: true, value: await call() }
  } catch (error) {
    return toFailureEnvelope(error)
  }
}

export function callWithEnvelopeSync<TValue>(call: () => TValue): WorkbenchFsCallResult<TValue> {
  try {
    return { ok: true, value: call() }
  } catch (error) {
    return toFailureEnvelope(error)
  }
}

function toFailureEnvelope(error: unknown): { ok: false; message: string; code?: ErrorCode } {
  if (error instanceof AppError) return { ok: false, message: error.message, code: error.code }

  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

export function hasStringFields(input: unknown, fields: string[]): input is Record<string, unknown> {
  return isRecord(input) && fields.every((field) => typeof input[field] === 'string')
}

export function optionalString(input: Record<string, unknown>, field: string): Record<string, string> {
  return typeof input[field] === 'string' ? { [field]: input[field] } : {}
}

export function optionalNumber(input: Record<string, unknown>, field: string): Record<string, number> {
  return typeof input[field] === 'number' ? { [field]: input[field] } : {}
}

export function optionalBoolean(
  input: Record<string, unknown>,
  field: string
): Record<string, boolean> {
  return typeof input[field] === 'boolean' ? { [field]: input[field] } : {}
}

/** 可选的字符串数组：没给是 `{}`；给了但不全是字符串返回 null（按无效请求处理）。 */
export function optionalStringArray(
  input: Record<string, unknown>,
  field: string
): Nullable<Record<string, string[]>> {
  const value = input[field]
  if (value === undefined) return {}
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null

  return { [field]: value as string[] }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
