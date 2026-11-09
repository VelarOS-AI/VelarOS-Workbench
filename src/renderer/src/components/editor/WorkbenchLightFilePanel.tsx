import { lazy, type ReactElement, Suspense } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { WorkbenchEditorVimHostCommand } from '@renderer/models/editor/workbenchEditorVim'
import { EMPTY_LIGHT_EDITOR_PROJECT_CONTEXT_INDEX } from '@renderer/models/lightEditorModel'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'
import type { WorkbenchLightEditorTab } from '@renderer/types/workbenchTypes'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchImagePreview } from './WorkbenchImagePreview'

const codeMirrorEditorModulePromise =
  import('./CodeMirrorEditor')

const LazyCodeMirrorEditor = lazy(async () => {
  const module = await codeMirrorEditorModulePromise

  return { default: module.CodeMirrorEditor }
})

interface WorkbenchLightFilePanelProps {
  tab: WorkbenchLightEditorTab
  workbenchTheme?: WorkbenchThemeId
  onContentChange?: (content: string) => void
  onSave?: () => void
  /** Vim 键位方案下 `:q`、`:wq`、`:wa` 要页面做的事。 */
  onVimCommand?: (command: WorkbenchEditorVimHostCommand) => void
  readOnly?: boolean
}

export function WorkbenchLightFilePanel({
  tab,
  readOnly = false,
  workbenchTheme = 'light-modern',
  onContentChange,
  onSave,
  onVimCommand,
}: WorkbenchLightFilePanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  if (tab.imagePreview)
    return (
      <section className={styles.lightEditorPanel}>
        <WorkbenchImagePreview path={tab.path} size={tab.size} preview={tab.imagePreview} />
      </section>
    )

  const languagePath = tab.path
  const language = fileLanguage(languagePath)

  return (
    <section className={styles.lightEditorPanel}>
      <div className={styles.lightEditorScroll}>
        <Suspense fallback={null}>
          <LazyCodeMirrorEditor
            projectRoot={tab.projectRoot}
            path={languagePath}
            language={language}
            value={tab.content}
            readOnly={readOnly || tab.truncated || !!tab.textIssue}
            disabled={false}
            projectContextIndex={EMPTY_LIGHT_EDITOR_PROJECT_CONTEXT_INDEX}
            workbenchTheme={workbenchTheme}
            onChange={(content) => onContentChange?.(content)}
            onOpenFind={() => undefined}
            onOpenGoToLine={() => undefined}
            onGoToDefinition={() => undefined}
            onSave={() => onSave?.()}
            onVimCommand={onVimCommand}
          />
        </Suspense>
        {!!tab.truncated && (
          <Text className={styles.lightEditorTruncated} tone="caption">
            {t('workbench.previewTruncated')}
          </Text>
        )}
      </div>
    </section>
  )
}
