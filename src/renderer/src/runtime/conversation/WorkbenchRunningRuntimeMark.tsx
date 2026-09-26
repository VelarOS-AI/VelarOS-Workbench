import { type ReactElement } from 'react'

import { VelarSailMark } from '@velaros-ai/ui/conversation'

import styles from './WorkbenchRunningRuntimeMark.module.css'

/** 运行状态行的执行体标记：Workbench 的对话都跑在 VelarOS Platform 上，用 Velar 帆标。 */
export function WorkbenchRunningRuntimeMark(): ReactElement {
  return (
    <span className={styles.sailMark} data-workbench-running-runtime-mark="workbench">
      <span className={styles.sailMarkScale}>
        <VelarSailMark decorative motion="steady" showWindLines={false} size="tiny" />
      </span>
    </span>
  )
}
