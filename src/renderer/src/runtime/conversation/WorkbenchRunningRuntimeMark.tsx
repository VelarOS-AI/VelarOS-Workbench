import { type ReactElement } from 'react'
import { useWorkbenchChatSurfaceProviderId } from '@renderer/composition'

import { VelarSailMark } from '@velaros-ai/ui/conversation'

import {
  isWorkbenchAgentEngineId,
} from '../../../../plugins/agent-engines/identity'
import { WorkbenchAgentEngineBrandIcon } from '../../../../plugins/agent-engines/renderer/WorkbenchAgentEngineBrandIcon'

import styles from './WorkbenchRunningRuntimeMark.module.css'

/**
 * 运行状态行的执行体标记。
 *
 * 身份来自包裹当前会话 Surface 的 provider 上下文：原生 Workbench 使用 Velar 帆标，
 * 外部 Agent 使用各自品牌图标。上下文缺席时返回 null，让共享会话 UI 回退官方 spinner。
 */
export function WorkbenchRunningRuntimeMark(): Nullable<ReactElement> {
  const providerId = useWorkbenchChatSurfaceProviderId()

  if (providerId === 'workbench') return (
    <span className={styles.sailMark} data-workbench-running-runtime-mark="workbench">
      <span className={styles.sailMarkScale}>
        <VelarSailMark decorative motion="steady" showWindLines={false} size="tiny" />
      </span>
    </span>
  )

  if (!isWorkbenchAgentEngineId(providerId)) return null
  return (
    <span className={styles.engineMark} data-workbench-running-runtime-mark={providerId}>
      <WorkbenchAgentEngineBrandIcon engineId={providerId} size={14} />
    </span>
  )
}
