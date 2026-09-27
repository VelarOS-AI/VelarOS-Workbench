import { readFile, stat } from 'node:fs/promises'

import { AppError } from '@velaros-ai/core/error'

import {
  countWorkbenchTextLines,
  type DecodedWorkbenchText,
  decodeWorkbenchText,
  detectWorkbenchTextBom,
} from './TextCodec'

/** 读到的文本文件：正文已去掉 BOM、换行统一为 LF，超过 maxChars 的部分截掉（截断的只读）。 */
interface WorkbenchTextFileSnapshot extends DecodedWorkbenchText {
  size: number
  modifiedAt: number
  totalLines: number
  truncated: boolean
}

const TextProbeSampleBytes = 4096
const TextProbeSuspiciousRatio = 0.08

/**
 * 文本似然门（照搬 desktop `workspace/workbench/TextFile.ts`）：NUL 立拒 + 控制字节占比 <8%。
 * 带 BOM 的 UTF-16 按 16 位码元判断——它的 ASCII 字符本来就带一个 0 字节。
 */
function isLikelyTextFile(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return true

  const bom = detectWorkbenchTextBom(buffer)
  if (bom?.encoding === 'utf-16le-bom' || bom?.encoding === 'utf-16be-bom') {
    const sample = buffer.subarray(bom.length, bom.length + TextProbeSampleBytes)
    return isLikelyUtf16Text(sample, bom.encoding === 'utf-16le-bom')
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, TextProbeSampleBytes))
  if (sample.includes(0)) return false

  let suspicious = 0
  for (const byte of sample) {
    if (isSuspiciousControl(byte)) suspicious += 1
  }

  return suspicious / sample.length < TextProbeSuspiciousRatio
}

function isLikelyUtf16Text(sample: Uint8Array, littleEndian: boolean): boolean {
  const units = Math.floor(sample.length / 2)
  if (units === 0) return true

  let suspicious = 0
  for (let index = 0; index < units; index += 1) {
    const low = sample[index * 2 + (littleEndian ? 0 : 1)]
    const high = sample[index * 2 + (littleEndian ? 1 : 0)]
    const unit = (high << 8) | low
    if (unit === 0) return false
    if (isSuspiciousControl(unit)) suspicious += 1
  }

  return suspicious / units < TextProbeSuspiciousRatio
}

function isSuspiciousControl(code: number): boolean {
  return code < 32 && code !== 9 && code !== 10 && code !== 13
}

/** 读项目里的一个文本文件：认出编码与换行符并核对能否原样写回。 */
async function readWorkbenchTextFile(
  path: string,
  maxChars: number
): Promise<WorkbenchTextFileSnapshot> {
  const fileStats = await stat(path)
  if (!fileStats.isFile()) {
    throw new AppError('VALIDATION', '工作台文件读取目标必须是文件。')
  }

  const buffer = await readFile(path)
  if (!isLikelyTextFile(buffer)) {
    throw new AppError('VALIDATION', '当前文件不是可预览的文本文件。')
  }

  const decoded = decodeWorkbenchText(buffer)
  const truncated = decoded.content.length > maxChars
  return {
    ...decoded,
    content: truncated ? decoded.content.slice(0, maxChars) : decoded.content,
    size: fileStats.size,
    modifiedAt: fileStats.mtimeMs,
    totalLines: countWorkbenchTextLines(decoded.content),
    truncated,
  }
}

export {
  isLikelyTextFile,
  isLikelyTextFile as isLikelyWorkbenchTextFile,
  readWorkbenchTextFile,
}
export type { WorkbenchTextFileSnapshot }
