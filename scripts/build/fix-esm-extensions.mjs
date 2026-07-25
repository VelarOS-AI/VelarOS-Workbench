#!/usr/bin/env node
// 用途：修正 package dist 中 ESM 相对 import/export 的文件扩展名。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

const targetArg = process.argv[2]
const distDir = targetArg ? resolve(process.cwd(), targetArg) : resolve(process.cwd(), 'dist')

if (!existsSync(distDir)) {
  console.error(`fix-esm-extensions: dist directory not found at ${distDir}`)
  process.exit(1)
}

let touchedFiles = 0
let touchedImports = 0

walk(distDir)

console.info(
  `fix-esm-extensions: rewrote ${touchedImports} imports in ${touchedFiles} files under ${distDir}.`
)

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full)
      continue
    }
    const ext = extname(full)
    if (ext !== '.js' && ext !== '.ts') continue
    fixFile(full)
  }
}

function fixFile(file) {
  const original = readFileSync(file, 'utf8')
  let updatedImports = 0
  const patched = original.replace(
    /(\bfrom\s+['"]|\bimport\s+['"]|\bimport\(\s*['"]|\bexport\s+(?:\*|\{[^}]*\}|type\s+\*|type\s+\{[^}]*\})\s+from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (match, prefix, specifier, suffix) => {
      const rewritten = rewriteSpecifier(file, specifier)
      if (!rewritten) return match
      updatedImports += 1
      return `${prefix}${rewritten}${suffix}`
    }
  )

  if (updatedImports > 0) {
    writeFileSync(file, patched, 'utf8')
    touchedFiles += 1
    touchedImports += updatedImports
  }
}

function rewriteSpecifier(fromFile, specifier) {
  if (/\.(js|mjs|cjs|json)$/.test(specifier)) return null

  const fromDir = dirname(fromFile)
  const candidateFile = resolve(fromDir, `${specifier}.js`)
  if (existsSync(candidateFile)) return `${specifier}.js`

  const candidateIndex = resolve(fromDir, specifier, 'index.js')
  if (existsSync(candidateIndex)) return `${specifier}/index.js`

  return null
}
