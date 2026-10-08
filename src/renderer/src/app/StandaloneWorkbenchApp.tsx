import { lazy, type ReactElement, Suspense, useEffect, useRef, useState } from 'react'
import { FolderOpenIcon } from '@phosphor-icons/react'
import { WorkbenchProductRuntimeProvider } from '@renderer/composition/WorkbenchProductRuntimeProvider'
import { WorkbenchLocalizationProvider } from '@renderer/i18n/WorkbenchLocalizationProvider'

import { WorkbenchProductAnalyticsNoticeDialog } from '../components/settings/WorkbenchProductAnalyticsNoticeDialog'
import { useProjectHubState } from '../hooks/useProjectHubState'
import { standaloneWorkbenchProductRuntimeValue } from '../host/standaloneWorkbenchProductRuntime'
import { useStandaloneWorkbenchLocalization } from '../i18n/useStandaloneWorkbenchLocalization'
import { WorkbenchMessageHost } from '../runtime/workbenchMessageHost'
import { NewProjectDialog } from '../welcome/NewProjectDialog'
import { WorkbenchWelcomePage } from '../welcome/WorkbenchWelcomePage'

import '../styles/projectDrop.css'

const LazyWorkbenchWorkspaceShell = lazy(async () => {
  const module = await import('./WorkbenchWorkspaceShell')
  return { default: module.WorkbenchWorkspaceShell }
})

/**
 * 独立 Workbench 应用的产品壳：起手页 ↔ 工作台按项目状态切换。
 *
 * 无项目 = 起手页（新建 / 打开 / 最近项目）；打开项目 = 完整工作台。
 * 项目状态唯一权威在 main 侧项目枢纽，这里只投影。两层 Provider：本地化（应用自持语言包）与产品运行时；
 * 聊天装配随工作台一起按需加载（见 WorkbenchWorkspaceShell），起手页不带它。
 */
export function StandaloneWorkbenchApp(): ReactElement {
  const { state, ready } = useProjectHubState()
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false)
  const [externalProjectDropActive, setExternalProjectDropActive] = useState(false)
  const externalDragDepthRef = useRef(0)
  const localization = useStandaloneWorkbenchLocalization()

  useEffect(
    () =>
      window.velarosWorkbenchProjectHub.onMenuCommand((command) => {
        if (command === 'new-project') setNewProjectDialogOpen(true)
      }),
    []
  )

  // 应用菜单等 main 侧的文字跟着界面语言走。
  useEffect(() => {
    window.velarosWorkbenchProjectHub.setLocale(localization.locale)
  }, [localization.locale])

  useEffect(() => {
    function hasExternalPaths(event: DragEvent): boolean {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function getDroppedFiles(event: DragEvent): File[] {
      const items = Array.from(event.dataTransfer?.items ?? [])
      const itemFiles = items.flatMap((item) => {
        const file = item.kind === 'file' ? item.getAsFile() : null
        return file ? [file] : []
      })
      return itemFiles.length > 0 ? itemFiles : Array.from(event.dataTransfer?.files ?? [])
    }

    function handleDragEnter(event: DragEvent): void {
      if (!hasExternalPaths(event)) return
      event.preventDefault()
      externalDragDepthRef.current += 1
      setExternalProjectDropActive(true)
    }

    function handleDragOver(event: DragEvent): void {
      if (externalDragDepthRef.current === 0) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    function handleDragLeave(event: DragEvent): void {
      if (externalDragDepthRef.current === 0) return
      event.preventDefault()
      externalDragDepthRef.current = Math.max(0, externalDragDepthRef.current - 1)
      if (externalDragDepthRef.current === 0) setExternalProjectDropActive(false)
    }

    function handleDrop(event: DragEvent): void {
      const files = getDroppedFiles(event)
      if (files.length === 0 && externalDragDepthRef.current === 0) return
      event.preventDefault()
      externalDragDepthRef.current = 0
      setExternalProjectDropActive(false)

      const paths = files
        .map((file) => {
          try {
            return window.velarosWorkbenchProjectHub.getPathForFile(file)
          } catch {
            return ''
          }
        })
        .filter((path) => path.length > 0)
      if (paths.length > 0) {
        void window.velarosWorkbenchProjectHub.openDroppedPaths(paths)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  if (!ready) return <></>

  return (
    <WorkbenchLocalizationProvider value={localization}>
      <WorkbenchProductRuntimeProvider value={standaloneWorkbenchProductRuntimeValue}>
        <div className="workbench-external-project-drop-root">
          {state.currentProject ? (
            <Suspense fallback={null}>
              <LazyWorkbenchWorkspaceShell
                project={state.currentProject}
                projectHubState={state}
              />
            </Suspense>
          ) : (
            <WorkbenchWelcomePage
              state={state}
              onNewProject={() => setNewProjectDialogOpen(true)}
            />
          )}
          <NewProjectDialog
            open={newProjectDialogOpen}
            onOpenChange={setNewProjectDialogOpen}
          />
          <WorkbenchMessageHost />
          <WorkbenchProductAnalyticsNoticeDialog />
          {externalProjectDropActive && (
            <div className="workbench-external-project-drop-overlay" role="status">
              <div className="workbench-external-project-drop-card">
                <FolderOpenIcon size={30} weight="duotone" />
                <span>{localization.t('workbench.dropProjectFolder')}</span>
                <small>{localization.t('workbench.dropProjectFolderHint')}</small>
              </div>
            </div>
          )}
        </div>
      </WorkbenchProductRuntimeProvider>
    </WorkbenchLocalizationProvider>
  )
}
