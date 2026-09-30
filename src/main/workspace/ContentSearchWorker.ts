/**
 * 内容搜索 worker 的入口（主进程构建的第二个入口之一，产物 `workbench-search-worker.js`）：收到一个请求就跑
 * 一个（见 ContentSearchTask），跑用户正则的活都在这里，卡住了由主进程结束整个 worker。
 */
import { parentPort } from 'node:worker_threads'

import { AppError } from '@velaros-ai/core/error'

import {
  handleWorkbenchContentSearchWorkerRequest,
  type WorkbenchContentSearchWorkerRequest,
} from './ContentSearchTask'

const port = (() => {
  if (!parentPort) throw new AppError('INVARIANT', 'Workbench 搜索 worker 缺少消息端口。')
  return parentPort
})()

port.on('message', (request: WorkbenchContentSearchWorkerRequest) => {
  void handleWorkbenchContentSearchWorkerRequest(request, (response) => port.postMessage(response))
})
