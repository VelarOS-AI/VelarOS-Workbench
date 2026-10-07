// 用途：在独占暂存目录准备标准 Agent 依赖，再替换本仓生成资源。
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareNodeRuntimePackages } from './nodeRuntimePackages.mjs'

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const cache = join(repository, 'build', 'cache')
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(join(cache, 'agent-runtime-'))
try {
  const prepared = join(temporary, 'prepared')
  await prepareNodeRuntimePackages(repository, prepared)
  const destination = join(cache, 'node-runtime')
  await rm(destination, { recursive: true, force: true })
  await rename(prepared, destination)
  console.log(`Prepared Workbench Agent runtime: ${destination}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
