import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'

import { resolveBrowserSearchOrNavigationInput } from '@velaros-ai/browser/core/contracts'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'

import {
  normalizeWorkbenchBrowserPageUrl,
  WorkbenchBrowserPartition,
} from '@shared/workbenchBrowser'

import styles from '../../styles/workbenchPageStyles'

/**
 * Workbench 内的人工调试页与 Agent 浏览器共用同一持久 partition。
 * 这样登录态、人工操作和聊天工具看到的是同一个浏览器环境，而不是两个互不相干的页面。
 */
type DebugWebviewElement = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  getWebContentsId: () => number
  reload: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
}

interface WebviewNavigateEvent extends Event {
  url?: string
}

interface WebviewTitleEvent extends Event {
  title?: string
}

interface WebviewFailLoadEvent extends Event {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
  isMainFrame?: boolean
}

export function normalizeWorkbenchBrowserAddress(input: string): string {
  const candidate = input.trim() === 'about:blank'
    ? 'about:blank'
    : resolveBrowserSearchOrNavigationInput(input)
  return candidate ? normalizeWorkbenchBrowserPageUrl(candidate) ?? '' : ''
}

interface WorkbenchWebviewDebugPanelProps {
  url: string
  partition?: string
  /** webview 内部导航后回填地址/标题给上层选项卡。 */
  onNavigate?: (url: string, title?: string) => void
  /** Agent 浏览器用此回调把同一份 guest WebContents 交给 main runtime 接管。 */
  onWebContentsReady?: (webContentsId: number, url: string) => void
}

export function WorkbenchWebviewDebugPanel({
  url,
  partition = WorkbenchBrowserPartition,
  onNavigate,
  onWebContentsReady,
}: WorkbenchWebviewDebugPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const webviewRef = useRef<Nullable<DebugWebviewElement>>(null)
  const readyRef = useRef(false)
  const lastLoadedRef = useRef('')
  const onNavigateRef = useRef(onNavigate)
  const onWebContentsReadyRef = useRef(onWebContentsReady)
  onNavigateRef.current = onNavigate
  onWebContentsReadyRef.current = onWebContentsReady

  const [addressDraft, setAddressDraft] = useState(url)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [failedLoad, setFailedLoad] = useState<Nullable<{ url: string; description: string }>>(null)

  const loadUrl = useCallback((target: string): void => {
    const webview = webviewRef.current
    const normalized = normalizeWorkbenchBrowserAddress(target)
    if (!webview || !readyRef.current || !normalized) return

    lastLoadedRef.current = normalized
    void webview.loadURL(normalized).catch(() => undefined)
  }, [])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const syncNavState = (): void => {
      try {
        setCanGoBack(webview.canGoBack())
        setCanGoForward(webview.canGoForward())
      } catch {
        // guest 尚未 ready 时 Electron 会抛错；下一次导航事件会重新同步。
      }
    }

    const handleDomReady = (): void => {
      readyRef.current = true
      syncNavState()
      const normalized = normalizeWorkbenchBrowserAddress(url)
      onWebContentsReadyRef.current?.(webview.getWebContentsId(), normalized)
      if (lastLoadedRef.current !== normalized) loadUrl(url)
    }

    const handleNavigate = (event: Event): void => {
      const nextUrl = (event as WebviewNavigateEvent).url
      if (!nextUrl || nextUrl === 'about:blank') {
        syncNavState()
        return
      }

      lastLoadedRef.current = nextUrl
      setCurrentUrl(nextUrl)
      setAddressDraft(nextUrl)
      syncNavState()
      onNavigateRef.current?.(nextUrl)
    }

    const handleTitle = (event: Event): void => {
      const title = (event as WebviewTitleEvent).title
      onNavigateRef.current?.(webview.getURL(), title)
    }

    const handleStartLoading = (): void => setFailedLoad(null)
    const handleFailLoad = (event: Event): void => {
      const failure = event as WebviewFailLoadEvent
      if (failure.isMainFrame === false || failure.errorCode === -3) return

      setFailedLoad({
        url: failure.validatedURL || webview.getURL() || lastLoadedRef.current,
        description: failure.errorDescription ?? '',
      })
      syncNavState()
    }

    webview.addEventListener('dom-ready', handleDomReady)
    webview.addEventListener('did-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleNavigate)
    webview.addEventListener('page-title-updated', handleTitle)
    webview.addEventListener('did-start-loading', handleStartLoading)
    webview.addEventListener('did-fail-load', handleFailLoad)

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady)
      webview.removeEventListener('did-navigate', handleNavigate)
      webview.removeEventListener('did-navigate-in-page', handleNavigate)
      webview.removeEventListener('page-title-updated', handleTitle)
      webview.removeEventListener('did-start-loading', handleStartLoading)
      webview.removeEventListener('did-fail-load', handleFailLoad)
    }
  }, [loadUrl, url])

  useEffect(() => {
    if (readyRef.current && normalizeWorkbenchBrowserAddress(url) !== lastLoadedRef.current) {
      setAddressDraft(url)
      loadUrl(url)
    }
  }, [url, loadUrl])

  const handleRetry = useCallback((): void => {
    const target = failedLoad?.url || currentUrl || addressDraft
    setFailedLoad(null)
    loadUrl(target)
  }, [addressDraft, currentUrl, failedLoad, loadUrl])

  const handleOpenExternal = useCallback((): void => {
    const target = normalizeWorkbenchBrowserAddress(
      failedLoad?.url || currentUrl || addressDraft
    )
    if (target) window.open(target, '_blank', 'noopener,noreferrer')
  }, [addressDraft, currentUrl, failedLoad])

  return (
    <div className={styles.webviewDebugPanel}>
      <div className={styles.webviewDebugChrome}>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.debugBack')}
          title={t('workbench.debugBack')}
          disabled={!canGoBack}
          onClick={() => {
            if (readyRef.current && webviewRef.current?.canGoBack()) webviewRef.current.goBack()
          }}
        >
          <ArrowLeftIcon size={15} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.debugForward')}
          title={t('workbench.debugForward')}
          disabled={!canGoForward}
          onClick={() => {
            if (readyRef.current && webviewRef.current?.canGoForward()) webviewRef.current.goForward()
          }}
        >
          <ArrowRightIcon size={15} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.debugReload')}
          title={t('workbench.debugReload')}
          onClick={() => {
            if (readyRef.current) webviewRef.current?.reload()
          }}
        >
          <ArrowClockwiseIcon size={15} />
        </IconButton>
        <form
          className={styles.webviewDebugAddressForm}
          onSubmit={(event) => {
            event.preventDefault()
            loadUrl(addressDraft)
          }}
        >
          <Input
            size="sm"
            variant="ghost"
            className={styles.webviewDebugAddressInput}
            value={addressDraft}
            spellCheck={false}
            aria-label={t('workbench.debugAddress')}
            placeholder={t('workbench.debugAddress')}
            onChange={(event) => setAddressDraft(event.target.value)}
          />
        </form>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.runOpenExternal')}
          title={t('workbench.runOpenExternal')}
          onClick={handleOpenExternal}
        >
          <ArrowSquareOutIcon size={15} />
        </IconButton>
      </div>
      <div className={styles.webviewDebugFrame}>
        <webview
          ref={(element) => {
            webviewRef.current = element as Nullable<DebugWebviewElement>
          }}
          partition={partition}
          src="about:blank"
          className={styles.webviewDebugView}
          data-failed={!!failedLoad}
        />
        {!!failedLoad && (
          <div className={styles.webviewDebugError} role="status" aria-live="polite">
            <div className={styles.webviewDebugErrorBody}>
              <span className={styles.webviewDebugErrorTitle}>
                {t('workbench.debugPageUnavailable')}
              </span>
              <span className={styles.webviewDebugErrorUrl}>{failedLoad.url}</span>
              <span className={styles.webviewDebugErrorHint}>
                {t('workbench.debugLoadFailedHint')}
                {failedLoad.description ? ` (${failedLoad.description})` : ''}
              </span>
              <IconButton
                variant="ghost"
                size="icon-sm"
                className={styles.webviewDebugRetryButton}
                label={t('workbench.debugReload')}
                title={t('workbench.debugReload')}
                onClick={handleRetry}
              >
                <ArrowClockwiseIcon size={16} />
              </IconButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
