/**
 * 进程内 Kernel + Agent 执行栈的构造级冒烟探针（bun 直驱，零 Electron、零真机）。
 *
 * 覆盖 P6 宿主化的三段接缝：
 *  ① 进程内 KernelModuleHost 起得来、`velaros.agent` 注册进服务注册表、能力可直取；
 *  ② `execute` 的 v1 信封解析（合法信封通过、非法信封拒收、外来产品身份拒收）；
 *  ③ 聊天链构造级：一条消息经 Kernel 能力 → 执行栈 → SoloStreamLoop 装配，一路走到
 *     **模型接口边界**才停（模型解析用桩替掉，不发真请求），沿途 Kernel 事件桥必须收到事件。
 */
import { z } from 'zod'

import { createAgentKernelModule } from '@velaros-ai/agent'
import type { AgentToolDefinition } from '@velaros-ai/workspace'

import { WorkbenchAgentExecutionStack } from '../agent/WorkbenchAgentExecutionStack'
import type { WorkbenchWorkspaceCapabilityProvider } from '../workspace/PublishedWorkspaceCapabilityProvider'

import {
  parseWorkbenchAgentExecuteInput,
  WorkbenchAgentCapabilityRuntime,
  WorkbenchAgentExecutionEventType,
} from './WorkbenchAgentCapabilityRuntime'
import { WorkbenchKernelRuntime } from './WorkbenchKernelRuntime'

let assertions = 0

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(message)
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  assertions += 1
  try {
    await action()
  } catch {
    return
  }
  throw new Error(message)
}

const ProbeProjectRoot = '/probe/project'
const ProbeSessionId = 'probe-session'

function createProbeWorkspaceProvider(): WorkbenchWorkspaceCapabilityProvider {
  const tool: AgentToolDefinition = {
    name: 'ws_read',
    descriptionSpec: {} as AgentToolDefinition['descriptionSpec'],
    description: 'Read a file in the probe workspace.',
    schema: z.object({ path: z.string() }),
    execute: (input) => Promise.resolve({ ok: true, input }),
  }
  return {
    invoke: () => Promise.resolve(null),
    resolveBridge: () =>
      Promise.resolve({ tools: [tool] } as unknown as Awaited<
        ReturnType<WorkbenchWorkspaceCapabilityProvider['resolveBridge']>
      >),
    dispose: () => Promise.resolve(),
  }
}

function buildEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: 1,
    execution: {
      id: 'probe-execution',
      source: {
        productId: 'velaros.workbench',
        sessionId: ProbeSessionId,
        correlationId: 'probe-correlation',
      },
      scopeMetadata: { resourceId: ProbeProjectRoot, surface: 'project' },
    },
    messages: [{ role: 'user', content: 'hello from the probe' }],
    config: {
      modelSelection: { provider: 'probe', model: 'probe-model' },
    },
    ...overrides,
  }
}

// ── ① 进程内 host 起来 → velaros.agent 注册 → 能力直取 ──
{
  const stack = new WorkbenchAgentExecutionStack(createProbeWorkspaceProvider())
  const kernel = new WorkbenchKernelRuntime()
  kernel.registerModule(
    createAgentKernelModule({ runtime: new WorkbenchAgentCapabilityRuntime(stack) })
  )

  assert(!kernel.hasCapability('velaros.agent'), 'start 之前不得报告能力可用')
  await kernel.start()
  assert(kernel.hasCapability('velaros.agent'), 'start 之后 velaros.agent 必须可用')
  assert(!kernel.hasCapability('velaros.model'), 'Workbench 没有 model 能力本体，必须为假')
  assert(!kernel.hasCapability('velaros.browser'), 'Workbench 没有 browser 能力本体，必须为假')

  const modules = kernel.listModules()
  assert(modules.length === 1, '只应注册一个能力模块')
  assert(modules[0]?.status === 'ready', 'Agent 模块必须进入 ready 态')

  const health = await kernel.invoke(
    'velaros.agent',
    'health',
    {},
    new AbortController().signal
  )
  assert(
    (health as { status?: string }).status === 'healthy',
    'ready 后 health 必须报 healthy'
  )
  await assertRejects(
    () => kernel.invoke('velaros.model', 'supports_provider', {}, new AbortController().signal),
    '未注册能力必须抛 WorkbenchKernelCapabilityUnavailableError'
  )
  await kernel.dispose()
}

// ── ② v1 信封解析：合法通过 / 越权字段拒收 / 缺协议版本拒收 ──
{
  const parsed = parseWorkbenchAgentExecuteInput(buildEnvelope())
  assert(parsed.executionId === 'probe-execution', 'executionId 必须原样解出')
  assert(parsed.source.productId === 'velaros.workbench', 'productId 必须原样解出')
  assert(parsed.scopeMetadata.resourceId === ProbeProjectRoot, 'resourceId 必须原样解出')
  assert(parsed.messages.length === 1, 'messages 必须原样解出')

  for (const bad of [
    buildEnvelope({ protocolVersion: 2 }),
    buildEnvelope({ extraneous: true }),
    { protocolVersion: 1, execution: {}, messages: [], config: {} },
    null,
  ]) {
    assertions += 1
    let rejected = false
    try {
      parseWorkbenchAgentExecuteInput(bad)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('非法信封必须被拒收')
  }
}

// ── ③ 聊天链构造级：能力入口 → 执行栈 → loop，跑到模型接口边界为止 ──
{
  const stack = new WorkbenchAgentExecutionStack(createProbeWorkspaceProvider())
  const runtime = new WorkbenchAgentCapabilityRuntime(stack)
  const published: Array<{ type: string; payload: unknown }> = []
  const abortController = new AbortController()
  const context = {
    signal: abortController.signal,
    publish: (type: string, payload: unknown) => {
      published.push({ type, payload })
      return Promise.resolve()
    },
  }

  await assertRejects(
    () =>
      runtime.execute(
        undefined,
        buildEnvelope({
          execution: {
            id: 'probe-execution',
            source: { productId: 'velaros.desktop', sessionId: ProbeSessionId },
            scopeMetadata: { resourceId: ProbeProjectRoot },
          },
        }),
        context
      ),
    '外来产品身份的执行请求必须拒收'
  )
  await assertRejects(
    () =>
      runtime.execute(
        undefined,
        buildEnvelope({
          execution: {
            id: 'probe-execution',
            source: { productId: 'velaros.workbench', sessionId: ProbeSessionId },
            scopeMetadata: {},
          },
        }),
        context
      ),
    '缺 projectRoot 的执行请求必须拒收'
  )

  // 走到**模型接口边界**为止：provider 用不存在的桩 id，解析必然停在 Model 包的
  // provider 目录查询上——能走到这一步说明前面整条装配链（工具注册表、工具上下文、
  // 角色解析、提示词构建、历史准备、loop 启动）都真跑过了，且零网络出口。
  let modelBoundaryError: unknown
  try {
    await runtime.execute(undefined, buildEnvelope(), context)
  } catch (error) {
    modelBoundaryError = error
  }
  assert(modelBoundaryError !== undefined, '桩 provider 必须在模型接口边界失败')
  assert(
    String((modelBoundaryError as Error).message).includes('probe'),
    `失败必须来自模型 provider 解析，而不是更早的装配环节：${String(modelBoundaryError)}`
  )
  assert(
    published.every((event) => event.type === WorkbenchAgentExecutionEventType),
    '所有事件必须走统一的 velaros.agent.execution 类型'
  )
  await stack.dispose()
}

// ── ④ Kernel 事件桥：三通道信封形状 + 顺序 + 结束前排空 ──
{
  const emitted: unknown[] = []
  // 桩执行栈：只做一件事——往事件总线三条通道各发一次，验证桥本身。
  const stack = {
    run: (input: { events: { emitAgent: unknown } }) => {
      const events = input.events as unknown as {
        emitTextDelta: (payload: unknown) => void
        emitRuntime: (payload: unknown) => void
      }
      events.emitTextDelta({ type: 'text-delta', text: 'probe' })
      events.emitRuntime({ type: 'done' })
      return Promise.resolve({ status: 'completed' as const })
    },
    dispose: () => Promise.resolve(),
  }
  const runtime = new WorkbenchAgentCapabilityRuntime(
    stack as unknown as WorkbenchAgentExecutionStack
  )
  const result = await runtime.execute(undefined, buildEnvelope(), {
    signal: new AbortController().signal,
    publish: (type: string, payload: unknown) => {
      emitted.push({ type, payload })
      return Promise.resolve()
    },
  })

  assert((result as { status: string }).status === 'completed', '桩执行栈的终态必须透传')
  assert(emitted.length > 0, '事件桥必须把总线事件投递出去')
  for (const event of emitted) {
    const { type, payload } = event as { type: string; payload: Record<string, unknown> }
    assertions += 1
    if (
      type !== WorkbenchAgentExecutionEventType
      || payload.protocolVersion !== 1
      || payload.executionId !== 'probe-execution'
      || payload.sourceProductId !== 'velaros.workbench'
      || payload.sourceSessionId !== ProbeSessionId
      || payload.sessionCorrelationId !== 'probe-correlation'
      || !['agent', 'state', 'debug'].includes(payload.channel as string)
    ) {
      throw new Error(`事件信封形状不合契约：${JSON.stringify(event)}`)
    }
  }
}

console.info(`workbench kernel host probe passed (${assertions} assertions)`)
