import { lazy, type ReactElement, Suspense } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  EMPTY_LIGHT_EDITOR_PROJECT_CONTEXT_INDEX,
  resolveLightEditorLanguagePath,
} from '@renderer/models/lightEditorModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'
import { fileLanguage } from '@renderer/models/shared/workbenchUtils'
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
  readOnly?: boolean
}

export function WorkbenchLightFilePanel({
  tab,
  readOnly = false,
  workbenchTheme = 'light-modern',
  onContentChange,
  onSave,
}: WorkbenchLightFilePanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  if (tab.imagePreview)
    return (
      <section className={styles.lightEditorPanel}>
        <WorkbenchImagePreview path={tab.path} size={tab.size} preview={tab.imagePreview} />
      </section>
    )

  // Office 预览按裁决归 desktop 查看器拓展面（WorkbenchOfficeFilePanel 不随迁独立宿主）；
  // 命中 office 附件时降级为不可编辑提示。
  if (tab.officePreview)
    return (
      <section className={styles.lightEditorPanel}>
        <div className={styles.officePreviewLoading} role="status">
          <Text tone="secondary">{t('workbench.previewTruncated')}</Text>
        </div>
      </section>
    )

  const languagePath = resolveLightEditorLanguagePath(tab)
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
