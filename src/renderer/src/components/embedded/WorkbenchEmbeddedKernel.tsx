/**
 * 工作台中央装配件（左侧面板 + 编辑面），考古自 desktop 同名组件。
 *
 * 左侧面板：文件树、提交、Velar 结构、AI 改动（每一轮 AI 运行一棵改动文件树）。「AI 改动」的对比
 * 标签由页面组装进编辑区的独占标签组，这里只放左侧面板。结构（embeddedChrome 包装 / 类名 /
 * resize 把手）与原文逐字一致。
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  Suspense,
  useEffect,
} from 'react'
import { GlobeSimpleIcon, RobotIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { WorkbenchDensity } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { lazyWithPreload, preloadWhenIdle } from '../../support/lazyWithPreload'
import { WorkbenchLogicGraphSidebar } from '../codeGraph/WorkbenchLogicGraphSidebar'
import { EditorGroupsPanel } from '../editor/EditorGroupsPanel'
import type { WorkbenchEditorPanelAuxiliaryTab } from '../editor/EditorPanel'
import { FilePanel } from '../files/FilePanel'

import type {
  WorkbenchEmbeddedKernelLeftMode,
  WorkbenchEmbeddedKernelModel,
} from './workbenchEmbeddedKernelModel'

// 提交、AI 改动、网页调试与 Agent 浏览器面板不进工作区外壳包：空闲时预先加载，切过去时一般已经就绪。
const LazyWorkbenchCommitPanel = lazyWithPreload(
  async () => (await import('../git/WorkbenchCommitPanel')).WorkbenchCommitPanel
)
const LazyWorkbenchAiChangesPanel = lazyWithPreload(
  async () => (await import('../aiChanges/WorkbenchAiChangesPanel')).WorkbenchAiChangesPanel
)
const LazyWorkbenchWebviewDebugPanel = lazyWithPreload(
  async () => (await import('../editor/WorkbenchWebviewDebugPanel')).WorkbenchWebviewDebugPanel
)
const LazyWorkbenchAgentBrowserPanel = lazyWithPreload(
  async () => (await import('../editor/WorkbenchAgentBrowserPanel')).WorkbenchAgentBrowserPanel
)

interface WorkbenchEmbeddedKernelProps {
  model: WorkbenchEmbeddedKernelModel
  leftMode: WorkbenchEmbeddedKernelLeftMode
  embeddedChrome?: WorkbenchEmbeddedKernelChrome
}

interface WorkbenchEmbeddedKernelChrome {
  density: WorkbenchDensity
  /**
   * 文件面板宽度：px 数值，或一段 CSS 长度。独立工作台传外壳上的 `var(--workbench-file-pane-width)`，
   * 拖分隔条时外壳变量逐帧直写，这里不必每帧重渲染也能跟上。
   */
  filePanelWidth: number | string
  isFilePanelOpen: boolean
  isFilePanelInline: boolean
  /** 编辑器字号等仅作用于代码面的偏好，显式穿过嵌套 shell，避免默认值覆盖。 */
  editorStyle?: CSSProperties
  onFilePanelResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function WorkbenchEmbeddedKernel({
  embeddedChrome,
  model,
  leftMode,
}: WorkbenchEmbeddedKernelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const { files, editor } = model
  useEffect(
    () =>
      preloadWhenIdle([
        LazyWorkbenchCommitPanel,
        LazyWorkbenchAiChangesPanel,
        LazyWorkbenchWebviewDebugPanel,
        LazyWorkbenchAgentBrowserPanel,
      ]),
    []
  )
  const { debug } = editor
  const debugAuxiliaryTabs: WorkbenchEditorPanelAuxiliaryTab[] = [
    ...debug.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      label: tab.title,
      icon: <GlobeSimpleIcon size={13} />,
      active: debug.activeTabId === tab.id,
      kind: 'webview-debug',
      content: null,
      onSelect: () => debug.onSelect(tab.id),
      onClose: () => debug.onClose(tab.id),
    })),
    ...(debug.agentBrowser
      ? [{
          id: debug.agentBrowser.id,
          title: debug.agentBrowser.title,
          label: debug.agentBrowser.title,
          icon: <RobotIcon size={13} />,
          active: debug.agentBrowser.active,
          kind: 'agent-browser',
          content: null,
          onSelect: debug.agentBrowser.onSelect,
          onClose: debug.agentBrowser.onClose,
        }]
      : []),
  ]
  const hasDebugTabsLayer = debug.tabs.length > 0 || !!debug.agentBrowser
  const debugTabsLayer = hasDebugTabsLayer ? (
    <Suspense fallback={null}>
      <div className={styles.webviewDebugLayer}>
        {debug.tabs.map((tab) => (
          <div
            key={tab.id}
            className={styles.webviewDebugLayerItem}
            data-active={debug.activeTabId === tab.id}
          >
            <LazyWorkbenchWebviewDebugPanel
              url={tab.url}
              onNavigate={(url, title) => debug.onNavigate(tab.id, url, title)}
            />
          </div>
        ))}
        {!!debug.agentBrowser && (
          <div
            key={debug.agentBrowser.id}
            className={styles.webviewDebugLayerItem}
            data-active={debug.agentBrowser.active}
          >
            <LazyWorkbenchAgentBrowserPanel
              projectRoot={debug.agentBrowser.projectRoot}
              sessionId={debug.agentBrowser.sessionId}
              url={debug.agentBrowser.url}
              active={debug.agentBrowser.active}
            />
          </div>
        )}
      </div>
    </Suspense>
  ) : null
  const editorDiff = {
    ...editor.diff,
    auxiliaryTabs: [...(editor.diff.auxiliaryTabs ?? []), ...debugAuxiliaryTabs],
    debugTabsLayer,
  }
  const leftPanel = (
    <div className={styles.leftToolContent}>
      <Suspense fallback={null}>
        {leftMode === 'ai-changes' ? (
          <LazyWorkbenchAiChangesPanel
            projectRoot={model.activeProject.rootPath}
            aiChanges={model.aiChanges}
          />
        ) : leftMode === 'changes' ? (
          <LazyWorkbenchCommitPanel
            git={model.changes.git}
            onOpenDiff={model.changes.onOpenDiff}
            onOpenFile={model.changes.onOpenFile}
          />
        ) : leftMode === 'velar-structure' && model.velarStructure ? (
          <WorkbenchLogicGraphSidebar {...model.velarStructure} />
        ) : (
          <FilePanel
            tree={files.tree}
            search={files.search}
            handlers={files.handlers}
          />
        )}
      </Suspense>
    </div>
  )
  const editorPanel = (
    <section className={styles.ideMainPane} data-tour-id="workbench-editor">
      <EditorGroupsPanel
        chrome={editor.chrome}
        showTopBar={editor.showTopBar}
        workbenchTheme={editor.workbenchTheme}
        workbenchProject={editor.workbenchProject}
        gitDecorations={editor.gitDecorations}
        gitStateRevision={editor.gitStateRevision}
        groups={editor.groups}
        layout={editor.layout}
        diff={editorDiff}
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
        data-workbench-density={embeddedChrome.density}
        style={
          {
            ...embeddedChrome.editorStyle,
            '--workbench-embedded-file-pane-width':
              typeof embeddedChrome.filePanelWidth === 'number'
                ? `${embeddedChrome.filePanelWidth}px`
                : embeddedChrome.filePanelWidth,
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
