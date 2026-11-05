import { Text } from '@codemirror/state'

import { isBlank, isEmpty } from '@velaros-ai/velaros/core'

export interface WorkbenchIndentGuideDescriptor {
  /** 零基、结束行不包含，匹配缩进引导描述模型。 */
  startLine: number
  endLine: number
  indentLevel: number
}

const MAX_WORKBENCH_INDENT_GUIDE_COLUMNS = 120

function countLeadingIndentColumns(lineText: string, tabSize: number): number {
  let columns = 0

  for (const char of lineText) {
    if (char === ' ') {
      columns += 1
      continue
    }

    if (char === '\t') {
      columns = (Math.floor(columns / tabSize) + 1) * tabSize
      continue
    }

    break
  }

  return Math.min(columns, MAX_WORKBENCH_INDENT_GUIDE_COLUMNS)
}

function firstNonWhitespaceIndex(lineText: string): number {
  for (let index = 0; index < lineText.length; index += 1) {
    const char = lineText[index]
    if (char !== ' ' && char !== '\t') return index
  }

  return lineText.length
}

function isCommentOnlyLine(textAfterIndent: string): boolean {
  return (
    textAfterIndent.startsWith('//') ||
    textAfterIndent.startsWith('/*') ||
    textAfterIndent.startsWith('*/') ||
    /^\*(?:\s|\/|$)/.test(textAfterIndent)
  )
}

function isClosingConstructLine(textAfterIndent: string): boolean {
  return /^[}\])]/.test(textAfterIndent)
}

function getDocLineText(doc: Text, lineIndex: number): string {
  return doc.line(lineIndex + 1).text
}

function calculateIdeaLineIndents(doc: Text, tabSize: number): number[] {
  const lineIndents: number[] = []

  for (let lineIndex = 0; lineIndex < doc.lines; lineIndex += 1) {
    const lineText = getDocLineText(doc, lineIndex)
    const firstNonWhitespace = firstNonWhitespaceIndex(lineText)
    const textAfterIndent = lineText.slice(firstNonWhitespace)

    lineIndents[lineIndex] =
      firstNonWhitespace === lineText.length || isCommentOnlyLine(textAfterIndent)
        ? -1
        : countLeadingIndentColumns(lineText, tabSize)
  }

  let topIndent = 0
  for (let lineIndex = 0; lineIndex < lineIndents.length; lineIndex += 1) {
    const lineIndent = lineIndents[lineIndex]
    if (lineIndent >= 0) {
      topIndent = lineIndent
      continue
    }

    const startLine = lineIndex
    while (lineIndex < lineIndents.length && lineIndents[lineIndex] < 0) {
      lineIndex += 1
    }

    const bottomIndent = lineIndex < lineIndents.length ? lineIndents[lineIndex] : topIndent
    let deducedIndent = Math.min(topIndent, bottomIndent)

    if (bottomIndent < topIndent && lineIndex < lineIndents.length) {
      const lineText = getDocLineText(doc, lineIndex)
      const textAfterIndent = lineText.slice(firstNonWhitespaceIndex(lineText))
      if (isClosingConstructLine(textAfterIndent)) {
        deducedIndent = topIndent
      }
    }

    for (let blankLine = startLine; blankLine < lineIndex; blankLine += 1) {
      lineIndents[blankLine] = -Math.min(topIndent, deducedIndent)
    }

    lineIndex -= 1
  }

  return lineIndents
}

function hasGuideBodyLine(
  lineIndents: readonly number[],
  indentLevel: number,
  startLine: number,
  endLine: number
): boolean {
  for (let lineIndex = startLine; lineIndex < endLine; lineIndex += 1) {
    if (Math.abs(lineIndents[lineIndex]) !== indentLevel) return true
  }

  return false
}

function createGuideDescriptor(
  lineIndents: readonly number[],
  indentLevel: number,
  startLine: number,
  endLine: number
): WorkbenchIndentGuideDescriptor {
  let normalizedStartLine = startLine
  while (normalizedStartLine > 0 && lineIndents[normalizedStartLine] < 0) {
    normalizedStartLine -= 1
  }

  return {
    indentLevel,
    startLine: normalizedStartLine,
    endLine,
  }
}

export function buildWorkbenchIdeaIndentGuideDescriptors(
  doc: Text,
  tabSize: number
): WorkbenchIndentGuideDescriptor[] {
  if (doc.length === 0) return []

  const lineIndents = calculateIdeaLineIndents(doc, tabSize)
  const lines: number[] = [0]
  const indents: number[] = [0]
  const descriptors: WorkbenchIndentGuideDescriptor[] = []

  for (let lineIndex = 1; lineIndex < lineIndents.length; lineIndex += 1) {
    const currentIndent = Math.abs(lineIndents[lineIndex])

    while (!isEmpty(indents) && currentIndent <= indents[indents.length - 1]) {
      const indentLevel = indents.pop()!
      const startLine = lines.pop()!
      if (indentLevel > 0 && hasGuideBodyLine(lineIndents, indentLevel, startLine, lineIndex)) {
        descriptors.push(createGuideDescriptor(lineIndents, indentLevel, startLine, lineIndex))
      }
    }

    const previousLine = lineIndex - 1
    const previousIndent = Math.abs(lineIndents[previousLine])
    if (currentIndent - previousIndent > 1) {
      lines.push(previousLine)
      indents.push(previousIndent)
    }
  }

  while (!isEmpty(indents)) {
    const indentLevel = indents.pop()!
    const startLine = lines.pop()!
    if (indentLevel > 0) {
      descriptors.push(
        createGuideDescriptor(lineIndents, indentLevel, startLine, lineIndents.length)
      )
    }
  }

  return descriptors
}

export function buildWorkbenchIdeaIndentGuideColumns(
  doc: Text,
  tabSize: number
): Map<number, number[]> {
  const columnsByLine = new Map<number, number[]>()

  for (const descriptor of buildWorkbenchIdeaIndentGuideDescriptors(doc, tabSize)) {
    for (let lineIndex = descriptor.startLine + 1; lineIndex < descriptor.endLine; lineIndex += 1) {
      const lineNumber = lineIndex + 1
      const columns = columnsByLine.get(lineNumber) ?? []
      if (!columns.includes(descriptor.indentLevel)) {
        columns.push(descriptor.indentLevel)
      }
      columnsByLine.set(lineNumber, columns)
    }
  }

  for (const columns of columnsByLine.values()) {
    columns.sort((a, b) => a - b)
  }

  return columnsByLine
}

export function buildWorkbenchIdeaIndentGuideColumnsForLineRange(
  doc: Text,
  tabSize: number,
  startLine: number,
  endLine: number,
  bufferLines = 60
): Map<number, number[]> {
  if (doc.length === 0) return new Map()

  const normalizedStart = Math.max(1, Math.min(startLine, doc.lines) - bufferLines)
  const normalizedEnd = Math.min(doc.lines, Math.max(endLine, normalizedStart) + bufferLines)
  const from = doc.line(normalizedStart).from
  const to = doc.line(normalizedEnd).to
  const sourceLines = doc.sliceString(from, to).split('\n')
  const hasSyntheticRoot = normalizedStart > 1
  const firstContentLine = sourceLines.find((line) => !isBlank(line)) ?? ''
  const syntheticIndent = Math.max(
    0,
    countLeadingIndentColumns(firstContentLine, tabSize) - tabSize
  )
  const localDoc = Text.of(
    hasSyntheticRoot ? [`${' '.repeat(syntheticIndent)}_`, ...sourceLines] : sourceLines
  )
  const localColumns = buildWorkbenchIdeaIndentGuideColumns(localDoc, tabSize)
  const globalLineOffset = hasSyntheticRoot ? normalizedStart - 2 : 0
  const columnsByLine = new Map<number, number[]>()

  for (const [localLine, columns] of localColumns) {
    const globalLine = localLine + globalLineOffset
    if (globalLine >= normalizedStart && globalLine <= normalizedEnd) {
      columnsByLine.set(globalLine, columns)
    }
  }

  return columnsByLine
}
