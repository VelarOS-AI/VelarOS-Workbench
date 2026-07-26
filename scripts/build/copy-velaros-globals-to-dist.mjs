#!/usr/bin/env node
// 用途：把源码编译期全局辅助类型改写为发布声明中的显式模块导入。
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const distDirectory = join(process.cwd(), 'dist')
const duplicateGlobals = join(distDirectory, 'velaros-globals.d.ts')
const utilityTypeModule = '@velaros-ai/ui/utility-types'
const utilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
]

if (!existsSync(distDirectory)) {
  throw new Error(`Missing declaration output directory: ${distDirectory}`)
}

rmSync(duplicateGlobals, { force: true })

function collectDeclarationFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry)
    return statSync(filePath).isDirectory()
      ? collectDeclarationFiles(filePath)
      : filePath.endsWith('.d.ts')
        ? [filePath]
        : []
  })
}

for (const declarationFile of collectDeclarationFiles(distDirectory)) {
  const sourceText = readFileSync(declarationFile, 'utf8')
  if (sourceText.includes(`from '${utilityTypeModule}'`)) continue

  const referencedTypes = utilityTypeNames.filter((name) =>
    new RegExp(`\\b${name}\\b`, 'u').test(sourceText)
  )
  if (referencedTypes.length === 0) continue

  writeFileSync(
    declarationFile,
    `import type { ${referencedTypes.join(', ')} } from '${utilityTypeModule}';\n${sourceText}`
  )
  const sourceMapFile = `${declarationFile}.map`
  if (existsSync(sourceMapFile)) {
    const sourceMap = JSON.parse(readFileSync(sourceMapFile, 'utf8'))
    sourceMap.mappings = `;${sourceMap.mappings ?? ''}`
    writeFileSync(sourceMapFile, JSON.stringify(sourceMap))
  }
}
