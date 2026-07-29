import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentModPackReader } from '@velaros-ai/agent-runtime'

/**
 * Agent mod pack 的磁盘读取端口（Workbench 侧）。
 *
 * 有界读取：只读 Kernel 报上来的 pack 目录下那一个 manifest 文件名，不遍历、不写入、
 * 不加载第三方代码。与 Desktop 的 `createDesktopAgentModPackReader` 同形——两个宿主
 * 共享同一套 Kernel ModStore 磁盘布局。领域 Loader 的 IO 全经此注入。
 */
function createWorkbenchAgentModPackReader(): AgentModPackReader {
  return {
    readManifest: async ({ packDirectory, manifestFileName }) => {
      const raw = await readFile(join(packDirectory, manifestFileName), 'utf8')
      return JSON.parse(raw)
    },
  }
}

export { createWorkbenchAgentModPackReader }
