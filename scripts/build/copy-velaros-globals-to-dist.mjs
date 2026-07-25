#!/usr/bin/env node
// 用途：把共享 velaros-globals.d.ts 复制到当前 package 的 dist 输出。
/**
 * 将仓库唯一的 `velaros-globals.d.ts` 复制到当前工作目录下包的 `dist/`，便于各包打包时随 `dist` 一起带上。
 *
 * 在各包 `package.json` 的 `build` 末尾、`tsc` 成功之后执行：
 * `node ../../scripts/build/copy-velaros-globals-to-dist.mjs`（在 `packages/<name>` 下 cwd 运行）。
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '../..')
const src = join(repoRoot, 'types/velaros-globals.d.ts')
const destDir = join(process.cwd(), 'dist')
const dest = join(destDir, 'velaros-globals.d.ts')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
