/**
 * 工作台中央装配件（文件面 + 编辑面），考古自 desktop 同名组件的片2 裁形。
 *
 * 相对 desktop 原文裁掉的分支（复活批次见各注）：
 * - aiChanges 存档 diff 辅助选项卡 + 左面板（Phase 3 AI 面批）；
 * - webview 调试选项卡层 + agent-browser 选项卡（desktop webview 耦合，独立宿主无此面）；
 * - 左面 'changes'（CommitPanel/会话变更，片4 git 面）与 'issues'（flagged tasks，Phase 3）。
 * 结构（embeddedChrome 包装 / 类名 / resize 把手）与原文逐字一致，方便后续批次 diff 回填。
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

import styles from '../../styles/workbenchPageStyles'
import { EditorPanel } from '../editor/EditorPanel'
import { FilePanel } from '../files/FilePanel'
import { WorkbenchCommitPanel } from '../git/WorkbenchCommitPanel'

import type {
  WorkbenchEmbeddedKernelLeftMode,
  WorkbenchEmbeddedKernelModel,
} from './workbenchEmbeddedKernelModel'

interface WorkbenchEmbeddedKernelProps {
  model: WorkbenchEmbeddedKernelModel
  leftMode: WorkbenchEmbeddedKernelLeftMode
  embeddedChrome?: WorkbenchEmbeddedKernelChrome
}

interface WorkbenchEmbeddedKernelChrome {
  filePanelWidth: number
  isFilePanelOpen: boolean
  isFilePanelInline: boolean
  onFilePanelResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function WorkbenchEmbeddedKernel({
  embeddedChrome,
  model,
  leftMode,
}: WorkbenchEmbeddedKernelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const { files, editor } = model
  const leftPanel = (
    <div className={styles.leftToolContent}>
      {leftMode === 'changes' ? (
        <WorkbenchCommitPanel
          git={model.changes.git}
          onOpenDiff={model.changes.onOpenDiff}
          onOpenFile={model.changes.onOpenFile}
        />
      ) : (
        <FilePanel
          tree={files.tree}
          search={files.search}
          git={files.git}
          handlers={files.handlers}
        />
      )}
    </div>
  )
  const editorPanel = (
    <section className={styles.ideMainPane} data-tour-id="workbench-editor">
      <EditorPanel
        chrome={editor.chrome}
        showTopBar={editor.showTopBar}
        workbenchTheme={editor.workbenchTheme}
        workbenchProject={editor.workbenchProject}
        workbenchEditor={editor.workbenchEditor}
        gitDecorations={editor.gitDecorations}
        selectedFileDiagnostics={editor.selectedFileDiagnostics}
        isSelectedFileDiagnosticsPending={editor.isSelectedFileDiagnosticsPending}
        tabs={editor.tabs}
        diff={editor.diff}
        workspace={editor.workspace}
      />
    </section>
  )

  if (embeddedChrome)
    return (
      <div
        className={`${styles.workbenchShell} ${styles.embeddedKernelRoot}`}
        data-tour-id="workbench-overview"
        data-file-panel-open={embeddedChrome.isFilePanelOpen}
        data-file-panel-inline={embeddedChrome.isFilePanelInline}
        data-workbench-theme={editor.workbenchTheme}
        data-workbench-density="compact"
        style={
          {
            '--workbench-embedded-file-pane-width': `${embeddedChrome.filePanelWidth}px`,
          } as CSSProperties
        }
      >
        <aside className={styles.embeddedFilePane} data-tour-id="workbench-file-tree">
          {leftPanel}
        </aside>
        {embeddedChrome.isFilePanelOpen && (
          <div
            className={styles.embeddedFileResizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resizeFilePane')}
            onPointerDown={embeddedChrome.onFilePanelResizePointerDown}
          />
        )}
        {editorPanel}
      </div>
    )

  return (
    <>
      {leftPanel}
      {editorPanel}
    </>
  )
}
