// Format the current change set without rewriting unrelated source files.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import prettier from 'prettier'

const root = resolve(import.meta.dirname, '..')
const changed = execFileSync('git', ['diff', '--diff-filter=ACMR', '--name-only', 'HEAD', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
const added = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
for (const file of new Set((changed + added).split('\0').filter(Boolean))) {
  if (!/\.(?:[cm]?js|tsx?|json|css)$/u.test(file)) continue
  const path = resolve(root, file)
  const options = await prettier.resolveConfig(path)
  const source = await readFile(path, 'utf8')
  const formatted = await prettier.format(source, { ...options, filepath: path })
  if (formatted !== source) await writeFile(path, formatted)
}
