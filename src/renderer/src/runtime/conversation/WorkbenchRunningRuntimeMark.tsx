import { type ReactElement } from 'react'

import { VelarSailMark } from '@velaros-ai/ui/conversation'

import { WorkbenchAgentEngineBrandIcon } from './WorkbenchAgentEngineBrandIcon'
import { useWorkbenchConversationEngine } from './workbenchConversationEngineContext'

import styles from '../../styles/WorkbenchRunningRuntimeMark.module.css'

/**
 * 运行状态行的执行体标记：VelarOS 自己的 Agent 用 Velar 帆标，交给外部引擎的会话用引擎的品牌图标。
 */
export function WorkbenchRunningRuntimeMark(): ReactElement {
  const engine = useWorkbenchConversationEngine()
  if (engine)
    return (
      <span className={styles.engineMark} data-workbench-running-runtime-mark={engine}>
        <WorkbenchAgentEngineBrandIcon engineId={engine} size={14} />
      </span>
    )
  return (
    <span className={styles.sailMark} data-workbench-running-runtime-mark="workbench">
      <span className={styles.sailMarkScale}>
        <VelarSailMark decorative motion="steady" showWindLines={false} size="tiny" />
      </span>
    </span>
  )
}
