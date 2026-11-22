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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge?.getTavilyConfigured) return
    let active = true
    void bridge.getTavilyConfigured().then(
      (value) => {
        if (active) setConfigured(value)
      },
      () => {
        if (active) setError(t('workbench.settingsTavilyError'))
      }
    )
    return () => {
      active = false
    }
  }, [bridge, t])

  const save = async (key: string): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await bridge.setTavilyApiKey(key)
      if (result.ok) {
        setConfigured(result.value)
        setDraft('')
      } else {
        setError(result.message)
      }
    } catch {
      setError(t('workbench.settingsTavilyError'))
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
        {error && <span role="alert">{error}</span>}
      </Inline>
    </SettingRow>
  )
}
