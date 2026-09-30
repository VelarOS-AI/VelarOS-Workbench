#!/usr/bin/env node
// 用途：记录并限制 Workbench 生产入口、启动依赖和总体积，避免功能改动悄悄拖慢启动。

import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const limits = Object.freeze({
  mainEntry: 3_750_000,
  mainJavaScript: 6_500_000,
  rendererStartup: 4_750_000,
  // 按需加载的块也算在内：其中约 19 MB 是聊天里代码高亮的语法包与 Mermaid 图表（来自 UI 包），启动时都不加载。
  rendererJavaScript: 26_000_000,
  rendererStyles: 1_000_000,
  rendererLargestAsset: 3_750_000,
})

async function listFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function totalBytes(files) {
  let total = 0
  for (const path of files) total += (await stat(path)).size
  return total
}

function formatBytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

async function inspectBundle(root = process.cwd()) {
  const electronRoot = resolve(root, 'build/electron')
  const mainRoot = resolve(electronRoot, 'main')
  const rendererRoot = resolve(electronRoot, 'renderer')
  const rendererHtml = await readFile(resolve(rendererRoot, 'index.html'), 'utf8')
  const mainFiles = await listFiles(mainRoot)
  const rendererFiles = await listFiles(rendererRoot)
  const startupRelativePaths = [...rendererHtml.matchAll(/(?:src|href)="\.?\/?([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((path) => path && ['.js', '.css'].includes(extname(path)))
  const startupFiles = [...new Set(startupRelativePaths)].map((path) => resolve(rendererRoot, path))
  const rendererAssets = rendererFiles.filter((path) => ['.js', '.css'].includes(extname(path)))
  const assetSizes = await Promise.all(rendererAssets.map(async (path) => ({
    path,
    size: (await stat(path)).size,
  })))

  return {
    mainEntry: (await stat(resolve(mainRoot, 'index.js'))).size,
    mainJavaScript: await totalBytes(mainFiles.filter((path) => extname(path) === '.js')),
    rendererStartup: await totalBytes(startupFiles),
    rendererJavaScript: await totalBytes(rendererFiles.filter((path) => extname(path) === '.js')),
    rendererStyles: await totalBytes(rendererFiles.filter((path) => extname(path) === '.css')),
    rendererLargestAsset: Math.max(0, ...assetSizes.map((asset) => asset.size)),
  }
}

export async function checkBuildBudgets(root = process.cwd()) {
  const metrics = await inspectBundle(root)
  const failures = Object.entries(limits)
    .filter(([name, limit]) => metrics[name] > limit)
    .map(([name, limit]) => `${name}: ${formatBytes(metrics[name])} > ${formatBytes(limit)}`)

  for (const [name, value] of Object.entries(metrics)) {
    console.log(`${name}: ${formatBytes(value)} / ${formatBytes(limits[name])}`)
  }
  if (failures.length > 0) {
    throw new Error(`Workbench bundle budget exceeded:\n${failures.join('\n')}`)
  }
  return metrics
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkBuildBudgets().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
