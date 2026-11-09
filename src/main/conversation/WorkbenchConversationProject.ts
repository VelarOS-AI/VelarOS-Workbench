import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  createProjectCapabilityModule,
  createProjectCodeModule,
  createProjectCodeQuery,
  createProjectContextSource,
  createProjectImagesModule,
  createProjectKernel,
  createProjectObservationProvider,
  type ProjectSpacePort,
  typeScriptProjects,
} from '@velaros-ai/capabilities/project'
import type { RuntimeResource } from '@velaros-ai/velaros'
import { AppError } from '@velaros-ai/velaros/core/error'

/** 项目、语言查询与证据源由 Workbench 显式选择，Runtime 不推导 IDE 能力。 */
const codeProjects = new Map<string, number>()

function acquireCodeProject(root: string): RuntimeResource {
  codeProjects.set(root, (codeProjects.get(root) ?? 0) + 1)
  let released = false
  return {
    close: () => {
      if (released) return
      released = true
      const remaining = codeProjects.get(root)! - 1
      if (remaining > 0) codeProjects.set(root, remaining)
      else {
        codeProjects.delete(root)
        typeScriptProjects.release(root)
      }
    },
  }
}

export async function createWorkbenchConversationProject(root: string, dataDir: string) {
  // 同根并发会话共享语言池；最后一个执行 lease 释放后才关，不能逐轮无条件释放。
  const resource = acquireCodeProject(root)
  try {
    const kernel = await createProjectKernel({
      root,
      transactionStatePath: join(dataDir, 'project-transactions.json'),
    })
    const project: ProjectSpacePort = {
      getRootPath: () => root,
      kernel: async () => kernel,
      queryCode: createProjectCodeQuery({
        isAvailable: () => false,
        query: async () => {
          throw new AppError('UNAVAILABLE', 'Workbench has no project graph index')
        },
      }),
    }
    const options = {
      instanceId: createHash('sha256').update(root).digest('hex'),
      generation: 1,
      project,
    }
    return {
      resource,
      modules: [
        createProjectCapabilityModule(options),
        createProjectCodeModule(options),
        createProjectImagesModule(options),
      ],
      // 项目内核限制真实根；同一运行时授权的 worker 复用源，不固定父会话 ID。
      source: createProjectContextSource({ id: 'project', kernel }),
      snapshot: createProjectObservationProvider(),
    }
  } catch (error) {
    await resource.close()
    throw error
  }
}
