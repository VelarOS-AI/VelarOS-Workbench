import type { OperationSurface } from '@velaros-ai/kernel'

const TaskInput = {
  type: 'object',
  properties: { taskId: { type: 'string', minLength: 1 } },
  required: ['taskId'],
  additionalProperties: false,
} as const

/** 将 Workbench 已有命令台作为按需宿主能力提供，不另建进程管理器。 */
export const WorkbenchConsoleCapability = {
  specifier: 'velaros:console',
  namespace: 'console',
  revision: '1',
  methods: ['start', 'list', 'read', 'stop'],
  declarations: `/** 持久命令台：开发服务器等需要在交付后继续运行的进程使用此入口。任务结束不会停止它；用户可在后台任务页查看和停止。会话删除或应用退出时回收。短命令仍用普通 Node/Execa。 */
declare module 'velaros:console' {
  interface Task { taskId: string; command: string; status: string }
  /** 在当前工作目录启动命令；不要用 detached/unref 绕过管理。返回启动身份后还需检查输出和地址，不能据此宣称服务已就绪。 */
  export function start(input: { command: string }): Promise<Task>
  /** 列出当前会话的任务，先检查是否已有所需服务器，避免重复启动。 */
  export function list(): Promise<Task[]>
  /** cursor 为上次返回的位置。输出有界；droppedChars 大于零表示旧输出已被缓冲区淘汰。 */
  export function read(input: { taskId: string; cursor?: number }): Promise<{ text: string; cursor: number; droppedChars: number; status: string }>
  /** 只停止指定任务；交付后仍需要访问的服务应保留，并向用户说明停止入口。 */
  export function stop(input: { taskId: string }): Promise<{ terminated: boolean; status: string; message: string }>
}`,
  template: `import * as consoleHost from 'velaros:console'
const tasks = await consoleHost.list()
console.log(tasks)
// 确认没有相同服务后：await consoleHost.start({ command: 'bun run dev' })`,
  operations: {
    start: {
      summary: '在当前工作区命令台启动交付后仍需保留的开发服务器或后台进程。',
      input: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 10000 },
        },
        required: ['command'],
        additionalProperties: false,
      },
      output: { type: 'object' },
      effects: 'write',
      allowedModes: ['execute'],
      hasInput: true,
    },
    list: {
      summary: '列出当前会话的持久后台任务。',
      input: { type: 'null' },
      output: { type: 'array', items: { type: 'object' } },
      effects: 'none',
      allowedModes: ['execute', 'observe'],
      hasInput: false,
    },
    read: {
      summary: '读取当前会话指定后台任务的增量输出。',
      input: {
        ...TaskInput,
        properties: {
          ...TaskInput.properties,
          cursor: { type: 'integer', minimum: 0 },
        },
      },
      output: { type: 'object' },
      effects: 'none',
      allowedModes: ['execute', 'observe'],
      hasInput: true,
    },
    stop: {
      summary: '停止当前会话的指定后台任务并回收进程树。',
      input: TaskInput,
      output: { type: 'object' },
      effects: 'write',
      allowedModes: ['execute'],
      hasInput: true,
    },
  },
} satisfies OperationSurface
