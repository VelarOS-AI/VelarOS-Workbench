import { Worker } from 'node:worker_threads'

import type {
  WorkbenchContentSearchWorkerOptions,
  WorkbenchContentSearchWorkerPort,
} from '../../src/main/workspace/ContentSearchWorkerHost'

/**
 * 从源码起内容搜索 worker（bun 直接跑 TypeScript）；应用里起的是构建产物 `workbench-search-worker.js`。
 */
export function createSourceSearchWorker(): WorkbenchContentSearchWorkerPort {
  return new Worker(
    new URL('../../src/main/workspace/ContentSearchWorker.ts', import.meta.url)
  ) as unknown as WorkbenchContentSearchWorkerPort
}

/** 用到内容搜索、项目替换的测试交给 createWorkbenchAppParts 的 searchWorker。 */
export const sourceSearchWorker: WorkbenchContentSearchWorkerOptions = {
  createWorker: createSourceSearchWorker,
}

/**
 * 回溯很久的正则与文件：八个 `\w*` 分一串字母，分法随长度的八次方涨，后面又没有分号，每种都得试一遍。
 * Electron（V8）里结束 worker 立刻停；bun 的正则停不下来，要跑完这两三秒才退出，所以别再加长。
 */
export const RunawayRegex = `${'\\w*'.repeat(8)};`
export const RunawayText = `${'a'.repeat(40)}\n`
