import { type ReactElement, useEffect } from 'react'
import { useStandaloneWorkbenchLocalization } from '@renderer/i18n/useStandaloneWorkbenchLocalization'
import {
  useWorkbenchI18n,
  WorkbenchLocalizationProvider,
} from '@renderer/i18n/WorkbenchLocalizationProvider'

import { WorkbenchSettingsDialog } from '../components/settings/WorkbenchSettingsDialog'
import { useProjectHubState } from '../hooks/useProjectHubState'
import { useWorkbenchKeymapController } from '../hooks/useWorkbenchKeymapController'
import { useWorkbenchPreferences } from '../hooks/useWorkbenchPreferences'
import { WorkbenchMessageHost } from '../runtime/workbenchMessageHost'

function SettingsSurface(): ReactElement {
  const preferences = useWorkbenchPreferences()
  const keymap = useWorkbenchKeymapController()
  const projectHub = useProjectHubState()
  const localization = useWorkbenchI18n()
  const project = projectHub.kind === 'ready' ? projectHub.state.currentProject : null

  useEffect(() => {
    window.velarosWorkbenchProjectHub.setLocale(localization.locale)
    document.title = localization.t('workbench.settingsTitle')
  }, [localization])

  return (
    <>
      <WorkbenchSettingsDialog
        open
        preferences={preferences.preferences}
        locale={localization.locale}
        keymap={keymap.keymap}
        keymapPreset={keymap.preset}
        presetShortcuts={keymap.presetShortcuts}
        conflicts={keymap.conflicts}
        project={project ? { name: project.name, rootPath: project.path } : null}
        onOpenChange={(open) => {
          if (!open) void window.velarosWorkbenchSettingsWindow.close()
        }}
        onExitProject={async () => {
          await window.velarosWorkbenchSettingsWindow.exitProject()
          return true
        }}
        onPreferencesChange={preferences.updatePreferences}
        onResetPreferences={preferences.resetPreferences}
        onKeymapPresetChange={keymap.setPreset}
        onSetShortcut={keymap.setShortcut}
        onResetShortcut={keymap.resetShortcut}
        onResetAllShortcuts={keymap.resetAllShortcuts}
        onLocaleChange={localization.setLocale}
      />
      <WorkbenchMessageHost />
    </>
  )
}

export function StandaloneWorkbenchSettingsWindow(): ReactElement {
  const localization = useStandaloneWorkbenchLocalization()
  return (
    <WorkbenchLocalizationProvider value={localization}>
      <SettingsSurface />
    </WorkbenchLocalizationProvider>
  )
}
