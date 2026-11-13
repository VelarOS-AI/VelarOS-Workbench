import { type CSSProperties, type ReactElement, useId } from 'react'
import {
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CodeIcon,
  FileCodeIcon,
  FolderIcon,
  FolderOpenIcon,
  MonitorIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type {
  WorkbenchAccent,
  WorkbenchDensity,
  WorkbenchPreferences,
  WorkbenchThemeId,
} from '@renderer/models/workbenchPreferences'

import type { AppLocale } from '@velaros-ai/ui/conversation/contracts'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Select } from '@velaros-ai/ui/primitives/forms/Select'

import styles from '../../styles/workbenchPageStyles'
import { ReadOnlyWorkbenchCode } from '../editor/ReadOnlyWorkbenchCode'

import { SettingRow, SettingsDisclosure } from './WorkbenchSettingsParts'

const Themes: Array<{
  value: WorkbenchThemeId
  labelKey: string
  color: string
  foreground: string
}> = [
  {
    value: 'light-modern',
    labelKey: 'settingsThemeLight',
    color: '#f1f3f6',
    foreground: '#64748b',
  },
  { value: 'dark-modern', labelKey: 'settingsThemeDark', color: '#25282e', foreground: '#cbd5e1' },
  {
    value: 'warm-paper',
    labelKey: 'settingsThemeWarmPaper',
    color: '#f2e7d5',
    foreground: '#a56a36',
  },
  {
    value: 'midnight-blue',
    labelKey: 'settingsThemeMidnightBlue',
    color: '#101a2b',
    foreground: '#82aaff',
  },
]

const Accents: Array<{ value: WorkbenchAccent; labelKey: string; color: string }> = [
  { value: 'blue', labelKey: 'settingsAccentBlue', color: '#2563eb' },
  { value: 'violet', labelKey: 'settingsAccentViolet', color: '#8b5cf6' },
  { value: 'rose', labelKey: 'settingsAccentRose', color: '#ec4899' },
  { value: 'orange', labelKey: 'settingsAccentOrange', color: '#f97316' },
  { value: 'amber', labelKey: 'settingsAccentAmber', color: '#d99a12' },
  { value: 'green', labelKey: 'settingsAccentGreen', color: '#16a34a' },
  { value: 'teal', labelKey: 'settingsAccentTeal', color: '#0d9488' },
  { value: 'slate', labelKey: 'settingsAccentSlate', color: '#64748b' },
]

const PreviewCode = `import { Workbench } from './core/workbench'

export class VelarOSWorkbench extends Workbench {
  async start() {
    await super.start()
    this.setup()
  }

  private setup() {
    // Build something great.
  }
}`

/** The preview uses the same read-only editor and theme as real files. */
function WorkbenchThemePreview({ theme }: { theme: WorkbenchThemeId }): ReactElement {
  const { t } = useWorkbenchI18n()
  return (
    <div
      className={styles.workbenchSettingsPreview}
      data-velar-theme-scope={theme}
      role="img"
      aria-label={t('workbench.settingsThemePreview')}
    >
      <div className={styles.workbenchSettingsPreviewHeader}>
        <CodeIcon size={15} weight="bold" />
        <span>VelarOS Workbench</span>
      </div>
      <div className={styles.workbenchSettingsPreviewBody} aria-hidden="true" inert>
        <div className={styles.workbenchSettingsPreviewFiles}>
          <div>
            <FolderOpenIcon size={15} /> VelarOS
          </div>
          <div>
            <FolderOpenIcon size={15} /> src
          </div>
          <div>
            <FolderIcon size={15} /> core
          </div>
          <div>
            <FileCodeIcon size={15} /> index.ts
          </div>
          <div data-active="true">
            <FileCodeIcon size={15} /> workbench.ts
          </div>
          <div>
            <FolderIcon size={15} /> renderer
          </div>
          <div>
            <FileCodeIcon size={15} /> package.json
          </div>
        </div>
        <div className={styles.workbenchSettingsPreviewEditor}>
          <div className={styles.workbenchSettingsPreviewTab}>
            <FileCodeIcon size={15} /> workbench.ts
          </div>
          <ReadOnlyWorkbenchCode
            content={PreviewCode}
            path="workbench.ts"
            workbenchTheme={theme}
            compact
          />
        </div>
      </div>
    </div>
  )
}

export function WorkbenchAppearanceSettings({
  preferences,
  locale,
  onPreferencesChange,
  onLocaleChange,
  onResetPreferences,
}: {
  preferences: WorkbenchPreferences
  locale: AppLocale
  onPreferencesChange: (patch: Partial<WorkbenchPreferences>) => void
  onLocaleChange: (locale: AppLocale) => void | Promise<void>
  onResetPreferences: () => void
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const themeGroup = useId()
  const accentGroup = useId()
  return (
    <>
      <SettingsDisclosure
        title={t('workbench.settingsTheme')}
        description={t('workbench.settingsThemeChoiceDescription')}
        defaultOpen
      >
        <div className={styles.workbenchSettingsAppearanceLayout}>
          <fieldset className={styles.workbenchSettingsThemeField}>
            <div className={styles.workbenchSettingsThemeChoices}>
              {Themes.map((theme) => {
                const selected = preferences.theme === theme.value
                return (
                  <label
                    key={theme.value}
                    className={styles.workbenchSettingsThemeChoice}
                    data-active={selected}
                  >
                    <input
                      className={styles.workbenchSettingsRadioInput}
                      type="radio"
                      name={themeGroup}
                      value={theme.value}
                      checked={selected}
                      onChange={() => onPreferencesChange({ theme: theme.value })}
                    />
                    <span
                      className={styles.workbenchSettingsThemeSample}
                      style={{ background: theme.color, color: theme.foreground }}
                      aria-hidden="true"
                    >
                      <MonitorIcon size={22} />
                    </span>
                    <span>{t(`workbench.${theme.labelKey}`)}</span>
                    {selected ? (
                      <CheckCircleIcon size={22} weight="fill" aria-hidden="true" />
                    ) : (
                      <CircleIcon size={22} aria-hidden="true" />
                    )}
                  </label>
                )
              })}
            </div>
          </fieldset>
          <WorkbenchThemePreview theme={preferences.theme} />
        </div>
      </SettingsDisclosure>
      <SettingsDisclosure
        title={t('workbench.settingsAccent')}
        description={t('workbench.settingsAccentDescription')}
      >
        <fieldset className={styles.workbenchSettingsAccentField}>
          <div className={styles.workbenchSettingsAccentChoices}>
            {Accents.map((accent) => (
              <label
                key={accent.value}
                className={styles.workbenchSettingsAccentChoice}
                data-active={preferences.accent === accent.value}
                title={t(`workbench.${accent.labelKey}`)}
                style={{ '--settings-swatch': accent.color } as CSSProperties}
              >
                <input
                  type="radio"
                  name={accentGroup}
                  value={accent.value}
                  checked={preferences.accent === accent.value}
                  aria-label={t(`workbench.${accent.labelKey}`)}
                  onChange={() => onPreferencesChange({ accent: accent.value })}
                />
                {preferences.accent === accent.value && (
                  <CheckIcon size={16} weight="bold" aria-hidden="true" />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      </SettingsDisclosure>
      <SettingsDisclosure
        title={t('workbench.settingsFineTune')}
        description={t('workbench.settingsAppearanceMore')}
      >
        <SettingRow title={t('workbench.settingsDensity')}>
          <SegmentedControl<WorkbenchDensity>
            ariaLabel={t('workbench.settingsDensity')}
            value={preferences.density}
            options={[
              { value: 'compact', label: t('workbench.settingsDensityCompact') },
              { value: 'balanced', label: t('workbench.settingsDensityBalanced') },
              { value: 'comfortable', label: t('workbench.settingsDensityComfortable') },
            ]}
            onChange={(density) => onPreferencesChange({ density })}
          />
        </SettingRow>
        <SettingRow title={t('workbench.settingsWorkbenchLanguage')}>
          <Select<AppLocale>
            value={locale}
            className={styles.workbenchSettingsSelectTrigger}
            options={[
              { value: 'zh-CN', label: t('common.chinese') },
              { value: 'en-US', label: t('common.english') },
            ]}
            onChange={(next) => void onLocaleChange(next)}
          />
        </SettingRow>
        <div className={styles.workbenchSettingsResetRow}>
          <Button variant="ghost" size="sm" onClick={onResetPreferences}>
            {t('workbench.settingsResetAppearance')}
          </Button>
        </div>
      </SettingsDisclosure>
    </>
  )
}
