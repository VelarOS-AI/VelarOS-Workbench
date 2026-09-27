/** 会话运行时的 Node 集成测试入口：Platform 的本地存储要 node:sqlite，bun 没有，测试打成包在 Node 里跑。 */
export { createWorkbenchConversationRuntime } from '../../src/main/conversation/WorkbenchConversationRuntime'
export { WorkbenchMemoryService } from '../../src/main/conversation/WorkbenchMemoryService'
export { WorkbenchShellHostRegistry } from '../../src/main/conversation/WorkbenchShellHostRegistry'
