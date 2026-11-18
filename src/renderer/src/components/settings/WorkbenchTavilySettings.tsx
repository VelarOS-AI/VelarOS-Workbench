import { type ReactElement, useEffect, useState } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'

import { SettingRow } from './WorkbenchSettingsParts'

export function WorkbenchTavilySettings(): ReactElement {
  const { t } = useWorkbenchI18n()
  const bridge = window.velarosWorkbenchSettingsWindow
  const [configured, setConfigured] = useState<Nullable<boolean>>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!bridge?.getTavilyConfigured) return
    let active = true
    void bridge.getTavilyConfigured().then(
      (value) => {
        if (active) setConfigured(value)
      },
      () => {
        if (active) setFailed(true)
      }
    )
    return () => {
      active = false
    }
  }, [bridge])

  const save = async (key: string): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try {
      setConfigured(await bridge.setTavilyApiKey(key))
      setDraft('')
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingRow
      title={t('workbench.settingsTavilyApiKey')}
      description={t('workbench.settingsTavilyApiKeyDescription')}
    >
      <Inline gap="xs" wrap="wrap" align="center">
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          aria-label={t('workbench.settingsTavilyApiKey')}
          placeholder={configured ? t('workbench.settingsTavilyConfigured') : undefined}
          value={draft}
          disabled={configured === null || saving}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={configured === null || saving || !draft.trim()}
          onClick={() => void save(draft.trim())}
        >
          {t('workbench.settingsTavilySave')}
        </Button>
        {configured && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save('')}>
            {t('workbench.settingsTavilyClear')}
          </Button>
        )}
        {failed && <span role="alert">{t('workbench.settingsTavilyError')}</span>}
      </Inline>
    </SettingRow>
  )
}
