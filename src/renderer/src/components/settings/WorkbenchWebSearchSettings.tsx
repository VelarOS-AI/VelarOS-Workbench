import { type ReactElement, useEffect, useState } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'
import { Inline } from '@velaros-ai/ui/primitives/layout/Inline'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

import type {
  WorkbenchWebSearchProvider,
  WorkbenchWebSearchSettings as SearchSettings,
  WorkbenchWebSearchUpdate,
} from '@shared/workbenchSettingsWindow'

import styles from '../../styles/workbenchPageStyles'

import { SettingRow } from './WorkbenchSettingsParts'

export function WorkbenchWebSearchSettings(): ReactElement {
  const { t } = useWorkbenchI18n()
  const bridge = window.velarosWorkbenchSettingsWindow
  const [settings, setSettings] = useState<SearchSettings | null>(null)
  const [selection, setSelection] = useState<WorkbenchWebSearchProvider | null>(null)
  const [endpointDraft, setEndpoint] = useState<string | null>(null)
  const [keyDraft, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = selection ?? settings?.provider ?? 'browser'
  const custom = settings?.custom
  const endpoint = endpointDraft ?? custom?.endpoint ?? ''
  const apiKey = keyDraft.trim()
  const configured = provider === 'custom' ? !!custom : !!settings?.tavilyConfigured
  const hasEdits = !!apiKey || (provider === 'custom' && endpointDraft !== null)
  const canSave =
    provider === 'custom'
      ? !!(
          endpoint.trim() &&
          (apiKey || (custom && URL.parse(endpoint.trim())?.href === custom.endpoint))
        )
      : !!apiKey
  const canEdit = !!settings && !saving
  const labels = {
    browser: t('workbench.settingsWebSearchBrowser'),
    tavily: 'Tavily',
    custom: t('workbench.settingsWebSearchCustom'),
  }

  useEffect(() => {
    let active = true
    void bridge.getWebSearch().then(
      (value) => {
        if (active) setSettings(value)
      },
      () => {
        if (active) setError(t('workbench.settingsTavilyError'))
      }
    )
    return () => {
      active = false
    }
  }, [bridge, t])

  function clearDrafts(): void {
    setEndpoint(null)
    setKey('')
    setError(null)
  }

  async function save(update: WorkbenchWebSearchUpdate): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await bridge.updateWebSearch(update)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setSettings(result.value)
      setSelection(null)
      clearDrafts()
    } catch {
      setError(t('workbench.settingsTavilyError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SettingRow
        title={t('workbench.settingsWebSearchProvider')}
        description={
          settings
            ? t('workbench.settingsWebSearchActive', { provider: labels[settings.provider] })
            : undefined
        }
      >
        <Select<WorkbenchWebSearchProvider>
          size="sm"
          className={styles.workbenchSettingsSelectTrigger}
          value={provider}
          disabled={!canEdit}
          options={[
            { value: 'browser', label: labels.browser },
            { value: 'tavily', label: labels.tavily },
            { value: 'custom', label: labels.custom },
          ]}
          onChange={(value) => {
            clearDrafts()
            setSelection(value)
          }}
        />
      </SettingRow>
      {provider === 'custom' && (
        <SettingRow
          title={t('workbench.settingsWebSearchEndpoint')}
          description={t('workbench.settingsWebSearchEndpointHint')}
        >
          <Input
            size="sm"
            type="url"
            aria-label={t('workbench.settingsWebSearchEndpoint')}
            value={endpoint}
            maxLength={2048}
            disabled={!canEdit}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
          />
        </SettingRow>
      )}
      {provider !== 'browser' && (
        <SettingRow
          title={
            provider === 'tavily'
              ? t('workbench.settingsTavilyApiKey')
              : t('workbench.settingsModelApiKey')
          }
          description={
            provider === 'custom' ? t('workbench.settingsWebSearchCustomKeyHint') : undefined
          }
        >
          <Stack gap="xs" className={styles.workbenchSettingsTavilyControls}>
            <Inline gap="xs" wrap="nowrap" align="center">
              <Input
                size="sm"
                type="password"
                autoComplete="off"
                maxLength={512}
                disabled={!canEdit}
                aria-label={t('workbench.settingsModelApiKey')}
                placeholder={configured ? t('workbench.settingsTavilyConfigured') : undefined}
                value={keyDraft}
                onChange={(event) => setKey(event.currentTarget.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || !canSave}
                onClick={() =>
                  void save(
                    provider === 'custom'
                      ? { action: 'save', provider, endpoint, apiKey }
                      : { action: 'save', provider, apiKey }
                  )
                }
              >
                {t('workbench.settingsTavilyVerify')}
              </Button>
              {configured && !hasEdits && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canEdit}
                  onClick={() => void save({ action: 'remove', provider })}
                >
                  {t('workbench.settingsTavilyClear')}
                </Button>
              )}
            </Inline>
          </Stack>
        </SettingRow>
      )}
      {settings &&
        settings.provider !== provider &&
        !hasEdits &&
        (provider === 'browser' || configured) && (
          <SettingRow title={labels[provider]}>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => void save({ action: 'select', provider })}
            >
              {t('workbench.settingsWebSearchActivate')}
            </Button>
          </SettingRow>
        )}
      {error && (
        <div className={styles.workbenchSettingsModelFeedback} role="alert">
          {error}
        </div>
      )}
    </>
  )
}
