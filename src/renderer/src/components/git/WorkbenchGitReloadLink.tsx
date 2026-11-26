import { type ReactElement, useState } from 'react'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'

import styles from '../../styles/workbenchPageStyles'

export function WorkbenchGitReloadLink(): ReactElement {
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [isReloading, setIsReloading] = useState(false)

  async function reload(): Promise<void> {
    setIsReloading(true)
    try {
      const result = await window.velarosWorkbenchGit.reloadEnvironment()
      if (result.ok) return
    } catch {
      // IPC 调用失败与环境刷新失败使用同一条提示。
    } finally {
      setIsReloading(false)
    }
    messageLatest.current.error({ title: tLatest.current('workbench.gitReloadFailed') })
  }

  return (
    <Button
      variant="link"
      className={styles.gitReloadLink}
      disabled={isReloading}
      onClick={() => void reload()}
    >
      {t(isReloading ? 'workbench.gitReloading' : 'workbench.gitReload')}
    </Button>
  )
}
