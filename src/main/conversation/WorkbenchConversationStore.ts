import { createHash } from 'node:crypto'
import { realpath, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Workbench 的会话存储边界：一个项目里的聊天一个目录。foundation-v1 只保存统一底座的新代际数据，
 * 旧代际不读取也不删除；项目归属与执行授权另由产品执行凭据核验。
 */
export class WorkbenchConversationStore {
  public constructor(private readonly root: string) {}

  /** 项目根的真实路径：Platform 按它绑定工作区、钳住项目操作。 */
  public workspace(projectRoot: string): Promise<string> {
    return realpath(projectRoot)
  }

  public path(projectRoot: string, sessionId: string): string {
    const key = createHash('sha256').update(`${resolve(projectRoot)}\0${sessionId}`).digest('hex')
    return join(this.root, 'foundation-v1', key)
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
