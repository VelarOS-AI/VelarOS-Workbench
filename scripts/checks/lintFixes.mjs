import { readFile, writeFile } from 'node:fs/promises'

const Bom = '\uFEFF'

function withoutBom(text) {
  return text.startsWith(Bom) ? text.slice(1) : text
}

function applyFixes(source, fixes) {
  const text = withoutBom(source)
  const hasBom = source.startsWith(Bom)
  let bom = hasBom ? Bom : ''
  let output = ''
  let lastEnd = -Infinity
  for (const fix of fixes.sort((left, right) =>
    left.range[0] - right.range[0] || left.range[1] - right.range[1])) {
    const [start, end] = fix.range
    if (
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start > end || end > text.length || end < 0 ||
      start < (hasBom ? -1 : 0)
    ) throw new Error('Invalid ESLint fix range')
    // Fixes sharing a boundary may include competing insertions. Leave them for fresh diagnostics.
    if (lastEnd >= start) continue
    if (start < 0 || (start === 0 && fix.text.startsWith(Bom))) bom = ''
    output += text.slice(Math.max(0, lastEnd), Math.max(0, start)) + fix.text
    lastEnd = end
  }
  return bom + output + text.slice(Math.max(0, lastEnd))
}

/** Apply one diagnostic batch against the exact source owned by the supplied Program. */
export async function applyTypedLintFixes(results, program) {
  const changed = []
  for (const result of results) {
    if (result.fatalErrorCount) continue
    const fixes = result.messages.filter((message) => message.fix).map((message) => message.fix)
    if (!fixes.length) continue
    const source = result.source
    const sourceFile = program.getSourceFile(result.filePath)
    if (
      typeof source !== 'string' || !sourceFile ||
      withoutBom(sourceFile.text) !== withoutBom(source)
    ) throw new Error(`Lint input differs from its TypeScript Program: ${result.filePath}`)
    const output = applyFixes(source, fixes)
    if (output === source) continue
    if (await readFile(result.filePath, 'utf8') !== source)
      throw new Error(`Lint input changed before fixes could be written: ${result.filePath}`)
    await writeFile(result.filePath, output, 'utf8')
    changed.push(result.filePath)
  }
  return changed
}
