/**
 * 调试器用的 source map：把「TypeScript 源码里的第几行」换成「实际在跑的那份 JS 里的位置」（下断点），
 * 再把调用栈里 JS 的位置换回源码（显示给用户）。只做这两件事，所以自己读 v3 格式，不引第三方库。
 *
 * 行列在这里一律从 0 起（与 Chrome DevTools 协议、source map 规范一致）；给界面用的从 1 起的行号由调用方换。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从 `generatedColumn` 起到下一段之前的映射；单字段片段没有对应源码。 */
type SourceMapSegment =
  | { generatedColumn: number; source: null }
  | {
      generatedColumn: number
      source: number
      originalLine: number
      originalColumn: number
    }

export interface WorkbenchSourceMapPosition {
  line: number
  column: number
}

export interface WorkbenchSourceMapOriginalPosition extends WorkbenchSourceMapPosition {
  /** 源文件的绝对路径。 */
  path: string
}

const Base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const Base64Values = new Map([...Base64Digits].map((digit, index) => [digit, index]))
const VlqContinuationBit = 32
const DataUrlPattern = /^data:application\/json[^,]*?(;base64)?,/iu
/** 地址开头的协议名。至少两个字符：Windows 的盘符（`C:\…`）不是协议。 */
const UrlSchemePattern = /^[a-z][a-z\d+.-]+:/iu

/** 解一行映射里逗号隔开的各段；每段是 1、4 或 5 个相对值（Base64 VLQ）。 */
function decodeSegmentFields(segment: string): number[] {
  const fields: number[] = []
  let value = 0
  let shift = 0
  for (const digit of segment) {
    const bits = Base64Values.get(digit)
    if (bits === undefined) return []
    value += (bits & (VlqContinuationBit - 1)) << shift
    if (bits & VlqContinuationBit) {
      shift += 5
      continue
    }
    // 最低位是符号位。
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return fields
}

/** `mappings` 解成按生成行分组、行内按列排好的段，保留无源码片段的列边界。 */
function decodeMappings(mappings: string): SourceMapSegment[][] {
  const lines: SourceMapSegment[][] = []
  let source = 0
  let originalLine = 0
  let originalColumn = 0

  for (const line of mappings.split(';')) {
    const segments: SourceMapSegment[] = []
    let generatedColumn = 0
    for (const segment of line.split(',')) {
      if (!segment) continue
      const fields = decodeSegmentFields(segment)
      if (fields.length === 0) continue

      generatedColumn += fields[0]!
      if (fields.length === 1) {
        segments.push({ generatedColumn, source: null })
        continue
      }
      if (fields.length < 4) continue
      source += fields[1]!
      originalLine += fields[2]!
      originalColumn += fields[3]!
      segments.push({ generatedColumn, source, originalLine, originalColumn })
    }
    segments.sort((left, right) => left.generatedColumn - right.generatedColumn)
    lines.push(segments)
  }
  return lines
}

/** `sources` 里的一项换成绝对路径；不是本机文件的（`webpack://…`、`http://…`）给 null。 */
function resolveSourcePath(
  source: string,
  sourceRoot: string,
  baseDirectory: string
): Nullable<string> {
  const joined =
    sourceRoot && !UrlSchemePattern.test(source) && !isAbsolute(source)
      ? `${sourceRoot.replace(/\/?$/u, '/')}${source}`
      : source
  if (joined.startsWith('file://')) {
    try {
      return fileURLToPath(joined)
    } catch {
      // arch-guard:silent-catch-ok 写坏了的 file: 地址：这个源文件对不上磁盘上的文件，按没有处理。
      return null
    }
  }
  if (UrlSchemePattern.test(joined)) return null
  return resolve(baseDirectory, joined)
}

export class WorkbenchSourceMap {
  /** 各源文件的绝对路径，下标与映射里的源编号对应；不是本机文件的为 null。 */
  public readonly sourcePaths: ReadonlyArray<Nullable<string>>
  private readonly rawMappings: string
  private generatedLines: Nullable<SourceMapSegment[][]> = null

  private constructor(sourcePaths: ReadonlyArray<Nullable<string>>, mappings: string) {
    this.sourcePaths = sourcePaths
    this.rawMappings = mappings
  }

  /**
   * 读一份 source map 的 JSON。`baseDirectory` 是它所在的目录（内联的就是脚本所在的目录），相对的源路径按它解析。
   * 不是 v3、没有 `mappings`、分段的索引表（`sections`）都不认，返回 null。
   */
  public static parse(json: string, baseDirectory: string): Nullable<WorkbenchSourceMap> {
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      // arch-guard:silent-catch-ok 坏掉的 source map：这份脚本按没有映射处理，断点落在生成的代码上。
      return null
    }
    if (typeof raw !== 'object' || raw === null) return null

    const map = raw as Record<string, unknown>
    if (map.version !== 3 || typeof map.mappings !== 'string' || !Array.isArray(map.sources))
      return null

    const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
    return new WorkbenchSourceMap(
      map.sources.map((source) =>
        typeof source === 'string' ? resolveSourcePath(source, sourceRoot, baseDirectory) : null
      ),
      map.mappings
    )
  }

  /** 这份映射里有没有这个源文件。 */
  public hasSource(path: string): boolean {
    return this.sourcePaths.includes(path)
  }

  /**
   * 生成代码里的一个位置对应源码的哪里：取这一行上起点不超过它的最后一段。落在单字段片段里，或这一行在它之前
   * 没有段（转换器加的代码），都返回 null：那不是用户写的任何一行。
   */
  public originalPositionFor(
    position: WorkbenchSourceMapPosition
  ): Nullable<WorkbenchSourceMapOriginalPosition> {
    const segments = this.lines()[position.line]
    if (!segments || segments.length === 0 || segments[0]!.generatedColumn > position.column)
      return null

    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (segments[middle]!.generatedColumn <= position.column) low = middle
      else high = middle - 1
    }
    const segment = segments[low]!
    if (segment.source === null) return null
    const path = this.sourcePaths[segment.source]
    return path ? { path, line: segment.originalLine, column: segment.originalColumn } : null
  }

  /**
   * 源码里的一行对应生成代码的哪里（下断点用）：这一行有映射就取其中生成位置最靠前的一段；这一行没有可执行的
   * 代码（空行、注释、类型声明）就顺延到后面最近的有映射的一行，`originalLine` 是实际落到的那一行。
   * 这个源文件后面再没有映射了返回 null。
   */
  public generatedPositionFor(
    path: string,
    line: number
  ): Nullable<WorkbenchSourceMapPosition & { originalLine: number }> {
    const source = this.sourcePaths.indexOf(path)
    if (source === -1) return null

    let best: Nullable<WorkbenchSourceMapPosition & { originalLine: number }> = null
    for (const [generatedLine, segments] of this.lines().entries()) {
      for (const segment of segments) {
        if (segment.source === null || segment.source !== source || segment.originalLine < line)
          continue
        // 先比落到源码的哪一行（越靠近要的那一行越好），同一行再比生成位置（越靠前越好）。
        if (
          !best ||
          segment.originalLine < best.originalLine ||
          (segment.originalLine === best.originalLine &&
            (generatedLine < best.line ||
              (generatedLine === best.line && segment.generatedColumn < best.column)))
        )
          best = {
            line: generatedLine,
            column: segment.generatedColumn,
            originalLine: segment.originalLine,
          }
      }
    }
    return best
  }

  /** 第一次要查位置时才解 `mappings`：大多数脚本的映射从头到尾用不上。 */
  private lines(): SourceMapSegment[][] {
    this.generatedLines ??= decodeMappings(this.rawMappings)
    return this.generatedLines
  }
}

/**
 * `//# sourceMappingURL=` 后面的地址是不是内联的 `data:` 地址；是就解出 JSON 原文，否则 null（那是一个文件
 * 路径或网址，由调用方去读）。
 */
export function decodeInlineSourceMap(sourceMapUrl: string): Nullable<string> {
  const match = DataUrlPattern.exec(sourceMapUrl)
  if (!match) return null

  const payload = sourceMapUrl.slice(match[0].length)
  try {
    return match[1] ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)
  } catch {
    // arch-guard:silent-catch-ok 编码坏掉的内联映射：按没有映射处理。
    return null
  }
}
