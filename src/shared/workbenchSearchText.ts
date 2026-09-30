/**
 * 搜索用得上、搜索之外也要用的两个小工具：行列换偏移（编辑器按行列选中一段），查找词按字面转义成正则
 * （拿选中的文字当正则查找词）。单独放一个文件：只用到它们的地方（编辑区、打开搜索）不用把整套匹配规则
 * （`@shared/workbenchTextSearch`）一起带上。
 */

const RegExpSyntaxCharacters = /[$()*+.?[\\\]^{|}]/gu

/** 行列（从 1 起）在正文里的偏移；超出行尾的列落在行尾，超出的行落在正文末尾。 */
export function resolveWorkbenchTextOffset(content: string, line: number, column: number): number {
  let lineStart = 0
  for (let current = 1; current < line; current += 1) {
    const lineBreak = content.indexOf('\n', lineStart)
    if (lineBreak === -1) return content.length
    lineStart = lineBreak + 1
  }
  const lineBreak = content.indexOf('\n', lineStart)
  const lineEnd = lineBreak === -1 ? content.length : lineBreak
  return Math.min(lineStart + Math.max(0, column - 1), lineEnd)
}

/** 文字原样当正则用时的写法。 */
export function escapeWorkbenchTextSearchRegExp(text: string): string {
  return text.replace(RegExpSyntaxCharacters, '\\$&')
}
