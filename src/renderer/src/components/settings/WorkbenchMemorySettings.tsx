import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { BrainIcon, EyeIcon, EyeSlashIcon, TrashIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n, type WorkbenchMessageKey } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import type { MemoryType } from '@velaros-ai/velaros/memory/contracts'

import type { WorkbenchMemoryEntry } from '@shared/workbenchMemory'

import styles from '../../styles/workbenchPageStyles'

const MemoryTypeLabels: Record<MemoryType, WorkbenchMessageKey> = {
  user: 'workbench.settingsMemoryTypeUser',
  feedback: 'workbench.settingsMemoryTypeFeedback',
  work: 'workbench.settingsMemoryTypeWork',
  reference: 'workbench.settingsMemoryTypeReference',
}

/**
 * 这个项目已存的长期记忆（与 Desktop 的记忆设置同一套）：能看正文、能删，删之前再点一次确认。
 * 记忆由模型在对话里存和删；这里不提供新建与编辑，要改内容直接改记忆目录里的 Markdown 文件。
 */
export function WorkbenchMemorySettings({
  projectRoot,
}: {
  projectRoot: Nullable<string>
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const [entries, setEntries] = useState<Nullable<WorkbenchMemoryEntry[]>>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Nullable<string>>(null)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmingId, setConfirmingId] = useState<Nullable<string>>(null)
  const [removingId, setRemovingId] = useState<Nullable<string>>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectRoot) {
      setEntries(null)
      return
    }
    setLoading(true)
    const result = await window.velarosWorkbenchMemory
      .listEntries({ projectRoot })
      .catch((cause: unknown) => ({ ok: false as const, message: String(cause) }))
    setLoading(false)
    if (result.ok) {
      setEntries(result.value)
      setError(null)
    } else {
      setError(t('workbench.settingsMemoryLoadFailed', { error: result.message }))
    }
  }, [projectRoot, t])

  useEffect(() => {
    setEntries(null)
    setOpenIds(new Set())
    setConfirmingId(null)
    void refresh()
  }, [refresh])

  const remove = async (entry: WorkbenchMemoryEntry): Promise<void> => {
    if (!projectRoot) return
    setRemovingId(entry.id)
    const result = await window.velarosWorkbenchMemory
      .removeEntry({ projectRoot, id: entry.id })
      .catch((cause: unknown) => ({ ok: false as const, message: String(cause) }))
    setRemovingId(null)
    setConfirmingId(null)
    if (!result.ok) {
      setError(t('workbench.settingsMemoryRemoveFailed', { error: result.message }))
      return
    }
    setEntries((current) => current?.filter((candidate) => candidate.id !== entry.id) ?? null)
  }

  const toggle = (id: string): void =>
    setOpenIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  if (!projectRoot)
    return (
      <div className={styles.workbenchSettingsAiRulesEmpty}>
        <Text tone="caption">{t('workbench.settingsMemoryNoProject')}</Text>
      </div>
    )

  if (loading && !entries)
    return (
      <div className={styles.workbenchSettingsAiRulesEmpty}>
        <Text>{t('workbench.settingsMemoryLoading')}</Text>
      </div>
    )

  return (
    <div className={styles.workbenchSettingsSectionPanel} data-workbench-memory-settings="true">
      {error && (
        <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
          {error}
        </Text>
      )}
      {entries?.length ? (
        <div className={styles.workbenchSettingsAiRuleList}>
          {entries.map((entry) => {
            const open = openIds.has(entry.id)
            const confirming = confirmingId === entry.id
            return (
              <div key={entry.id} className={styles.workbenchSettingsAiRuleItem}>
                <div className={styles.workbenchSettingsAiRuleRow}>
                  <span className={styles.workbenchSettingsAiRuleIcon}>
                    <BrainIcon size={15} />
                  </span>
                  <span className={styles.workbenchSettingsAiRuleMain}>
                    <span className={styles.workbenchSettingsAiRuleHeader}>
                      <Text className={styles.workbenchSettingsAiRulePath}>{entry.title}</Text>
                      <span className={styles.workbenchSettingsAiRuleBadges}>
                        <span className={styles.workbenchSettingsPill} data-tone="default">
                          {t(MemoryTypeLabels[entry.type])}
                        </span>
                      </span>
                    </span>
                    {!!entry.description && (
                      <Text tone="caption" className={styles.workbenchSettingsRowDescription}>
                        {entry.description}
                      </Text>
                    )}
                  </span>
                  {confirming ? (
                    <span className={styles.workbenchSettingsAiRuleBadges}>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={removingId === entry.id}
                        onClick={() => void remove(entry)}
                      >
                        {t('workbench.settingsMemoryRemoveConfirm')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmingId(null)}>
                        {t('workbench.settingsMemoryRemoveCancel')}
                      </Button>
                    </span>
                  ) : (
                    <span className={styles.workbenchSettingsAiRuleBadges}>
                      <IconButton
                        size="icon-sm"
                        variant="ghost"
                        label={t(
                          open ? 'workbench.settingsMemoryHideContent' : 'workbench.settingsMemoryShowContent'
                        )}
                        onClick={() => toggle(entry.id)}
                      >
                        {open ? <EyeSlashIcon size={15} /> : <EyeIcon size={15} />}
                      </IconButton>
                      <IconButton
                        size="icon-sm"
                        variant="ghost"
                        label={t('workbench.settingsMemoryRemove')}
                        onClick={() => setConfirmingId(entry.id)}
                      >
                        <TrashIcon size={15} />
                      </IconButton>
                    </span>
                  )}
                </div>
                {open && <pre className={styles.workbenchSettingsAiRuleContent}>{entry.content}</pre>}
              </div>
            )
          })}
        </div>
      ) : (
        <div className={styles.workbenchSettingsAiRulesEmpty}>
          <Text tone="caption" className={styles.workbenchSettingsAiRulesEmptyDescription}>
            {t('workbench.settingsMemoryEmpty')}
          </Text>
        </div>
      )}
    </div>
  )
}
