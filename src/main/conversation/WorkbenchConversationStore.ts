import { createHash } from 'node:crypto'
import { realpath, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Platform 会话数据的目录映射（与 Desktop 的会话目录同一做法）：一个聊天会话一个目录，上下文、运行状态与
 * 项目事务都在里面。Workbench 的会话属于某个项目，目录按 (项目根, 会话) 认——Platform 把会话永久绑在
 * 第一次打开它的工作区上，同一个会话 id 不会跨项目复用这份数据。
 */
export class WorkbenchConversationStore {
  public constructor(private readonly root: string) {}

  /** 项目根的真实路径：Platform 按它绑定工作区、钳住项目操作。 */
  public workspace(projectRoot: string): Promise<string> {
    return realpath(projectRoot)
  }

  public path(projectRoot: string, sessionId: string): string {
    const key = createHash('sha256').update(`${resolve(projectRoot)}\0${sessionId}`).digest('hex')
    return join(this.root, key)
  }

  public async exists(projectRoot: string, sessionId: string): Promise<boolean> {
    try {
      return (await stat(this.path(projectRoot, sessionId))).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  public delete(projectRoot: string, sessionId: string): Promise<void> {
    return rm(this.path(projectRoot, sessionId), { recursive: true, force: true })
  }
}
