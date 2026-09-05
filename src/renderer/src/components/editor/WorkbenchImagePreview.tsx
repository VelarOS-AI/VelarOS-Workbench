import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { CornersInIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  canStepWorkbenchImageZoom,
  formatWorkbenchImageZoom,
  resolveWorkbenchImageFitZoom,
  resolveWorkbenchImageWheelZoom,
  resolveWorkbenchImageZoomShortcut,
  stepWorkbenchImageZoom,
  WORKBENCH_IMAGE_MAX_MANUAL_ZOOM,
  WORKBENCH_IMAGE_MIN_MANUAL_ZOOM,
  type WorkbenchImageZoomDirection,
} from '@renderer/models/editor/workbenchImagePreview'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { WorkbenchImagePreview as WorkbenchImagePreviewData } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchImagePreviewProps {
  path: string
  size: number
  preview: WorkbenchImagePreviewData
}

interface ImageObjectUrl {
  data: Uint8Array
  mediaType: WorkbenchImagePreviewData['mediaType']
  value: string
}

interface ImageLoadState {
  data: Uint8Array
  status: 'failed' | 'loaded'
  width: number
  height: number
}

interface ImagePreviewViewport {
  height: number
  width: number
}

interface ImagePreviewDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startScrollLeft: number
  startScrollTop: number
}

interface ImagePreviewZoomAnchor {
  imageX: number
  imageY: number
  viewportX: number
  viewportY: number
}

type ImagePreviewZoomMode = 'fit' | 'manual'

const ImageFormatLabels: Readonly<Record<WorkbenchImagePreviewData['mediaType'], string>> = {
  'image/png': 'PNG',
  'image/svg+xml': 'SVG',
  'image/webp': 'WebP',
}

function formatByteSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`

  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/u).findLast((segment) => !!segment) ?? path
}

export function WorkbenchImagePreview({
  path,
  size,
  preview,
}: WorkbenchImagePreviewProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [objectUrl, setObjectUrl] = useState<Nullable<ImageObjectUrl>>(null)
  const [loadState, setLoadState] = useState<Nullable<ImageLoadState>>(null)
  const [zoomMode, setZoomMode] = useState<ImagePreviewZoomMode>('fit')
  const [manualZoom, setManualZoom] = useState(1)
  const [viewport, setViewport] = useState<ImagePreviewViewport>({ height: 1, width: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const [isPannable, setIsPannable] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const dragStateRef = useRef<Nullable<ImagePreviewDragState>>(null)
  const zoomAnchorRef = useRef<Nullable<ImagePreviewZoomAnchor>>(null)

  useLayoutEffect(() => {
    const bytes = Uint8Array.from(preview.data)
    const value = URL.createObjectURL(new Blob([bytes], { type: preview.mediaType }))
    setObjectUrl({ data: preview.data, mediaType: preview.mediaType, value })

    return () => URL.revokeObjectURL(value)
  }, [preview.data, preview.mediaType])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return

    const updateViewport = (): void => {
      const stageStyle = window.getComputedStyle(stage)
      const horizontalPadding =
        Number.parseFloat(stageStyle.paddingLeft) + Number.parseFloat(stageStyle.paddingRight)
      const verticalPadding =
        Number.parseFloat(stageStyle.paddingTop) + Number.parseFloat(stageStyle.paddingBottom)

      setViewport({
        width: Math.max(1, canvas.clientWidth - horizontalPadding),
        height: Math.max(1, canvas.clientHeight - verticalPadding),
      })
    }

    const resizeObserver = new ResizeObserver(updateViewport)
    resizeObserver.observe(canvas)
    window.addEventListener('resize', updateViewport)
    updateViewport()

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  const currentObjectUrl =
    objectUrl?.data === preview.data && objectUrl.mediaType === preview.mediaType
      ? objectUrl.value
      : null
  const currentLoadState = loadState?.data === preview.data ? loadState : null
  const failed = currentLoadState?.status === 'failed'
  const fitZoom = currentLoadState?.status === 'loaded'
    ? resolveWorkbenchImageFitZoom({
        naturalWidth: currentLoadState.width,
        naturalHeight: currentLoadState.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      })
    : 1
  const zoom = zoomMode === 'fit' ? fitZoom : manualZoom
  const zoomLabel = formatWorkbenchImageZoom(zoom)
  const scaledSize = currentLoadState?.status === 'loaded'
    ? {
        height: currentLoadState.height * zoom,
        width: currentLoadState.width * zoom,
      }
    : null
  const fileName = fileNameFromPath(path)
  const metadata = [
    ImageFormatLabels[preview.mediaType],
    currentLoadState?.status === 'loaded'
      ? `${currentLoadState.width} × ${currentLoadState.height}`
      : null,
    formatByteSize(size),
  ].filter((value): value is string => !!value)

  const resetScrollPosition = useCallback((): void => {
    requestAnimationFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.scrollLeft = 0
      canvas.scrollTop = 0
    })
  }, [])

  const captureZoomAnchor = useCallback((clientX?: number, clientY?: number): void => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) {
      zoomAnchorRef.current = null
      return
    }

    const canvasBounds = canvas.getBoundingClientRect()
    const imageBounds = image.getBoundingClientRect()
    const viewportX = clientX === undefined ? canvas.clientWidth / 2 : clientX - canvasBounds.left
    const viewportY = clientY === undefined ? canvas.clientHeight / 2 : clientY - canvasBounds.top
    const imageX = imageBounds.width > 0
      ? (canvasBounds.left + viewportX - imageBounds.left) / imageBounds.width
      : 0.5
    const imageY = imageBounds.height > 0
      ? (canvasBounds.top + viewportY - imageBounds.top) / imageBounds.height
      : 0.5

    zoomAnchorRef.current = {
      imageX: Math.min(1, Math.max(0, imageX)),
      imageY: Math.min(1, Math.max(0, imageY)),
      viewportX,
      viewportY,
    }
  }, [])

  const setFitZoom = useCallback((): void => {
    zoomAnchorRef.current = null
    setZoomMode('fit')
    resetScrollPosition()
  }, [resetScrollPosition])

  const setActualSize = useCallback((): void => {
    captureZoomAnchor()
    setManualZoom(1)
    setZoomMode('manual')
  }, [captureZoomAnchor])

  const zoomBy = useCallback((
    direction: WorkbenchImageZoomDirection,
    clientX?: number,
    clientY?: number
  ): void => {
    if (!canStepWorkbenchImageZoom(zoom, direction)) return

    captureZoomAnchor(clientX, clientY)
    setManualZoom(stepWorkbenchImageZoom(zoom, direction))
    setZoomMode('manual')
  }, [captureZoomAnchor, zoom])

  const cancelDrag = useCallback((pointerId?: number): void => {
    const canvas = canvasRef.current
    const dragState = dragStateRef.current
    if (!dragState || (pointerId !== undefined && dragState.pointerId !== pointerId)) return

    dragStateRef.current = null
    if (canvas?.hasPointerCapture(dragState.pointerId))
      canvas.releasePointerCapture(dragState.pointerId)
    setIsDragging(false)
  }, [])

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.focus()
    if (event.button !== 0 || !isPannable || dragStateRef.current) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
    }
    setIsDragging(true)
  }, [isPannable])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    event.preventDefault()
    event.currentTarget.scrollLeft =
      dragState.startScrollLeft - (event.clientX - dragState.startClientX)
    event.currentTarget.scrollTop =
      dragState.startScrollTop - (event.clientY - dragState.startClientY)
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
    const action = resolveWorkbenchImageZoomShortcut(
      event.key,
      event.metaKey || event.ctrlKey || event.altKey
    )
    if (!action) return

    event.preventDefault()
    if (action === 'fit') setFitZoom()
    else if (action === 'actual') setActualSize()
    else zoomBy(action)
  }, [setActualSize, setFitZoom, zoomBy])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (event: WheelEvent): void => {
      const direction = resolveWorkbenchImageWheelZoom(
        event.deltaY,
        event.metaKey || event.ctrlKey
      )
      if (!direction) return

      event.preventDefault()
      zoomBy(direction, event.clientX, event.clientY)
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [zoomBy])

  useEffect(() => {
    setZoomMode('fit')
    setManualZoom(1)
    zoomAnchorRef.current = null
    cancelDrag()
    resetScrollPosition()
  }, [cancelDrag, path, preview.data, preview.mediaType, resetScrollPosition])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!anchor || !canvas || !image) return

    zoomAnchorRef.current = null
    const canvasBounds = canvas.getBoundingClientRect()
    const imageBounds = image.getBoundingClientRect()
    canvas.scrollLeft +=
      imageBounds.left + imageBounds.width * anchor.imageX
      - (canvasBounds.left + anchor.viewportX)
    canvas.scrollTop +=
      imageBounds.top + imageBounds.height * anchor.imageY
      - (canvasBounds.top + anchor.viewportY)
  }, [scaledSize?.height, scaledSize?.width])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      setIsPannable(
        canvas.scrollWidth > canvas.clientWidth + 1
        || canvas.scrollHeight > canvas.clientHeight + 1
      )
    })

    return () => cancelAnimationFrame(frame)
  }, [scaledSize?.height, scaledSize?.width, viewport.height, viewport.width])

  return (
    <section className={styles.imagePreview}>
      <div
        ref={canvasRef}
        className={styles.imagePreviewCanvas}
        role="region"
        aria-label={t('workbench.imagePreviewLabel', { name: fileName })}
        aria-keyshortcuts="+ - 0 F"
        data-dragging={isDragging ? 'true' : undefined}
        data-pannable={isPannable ? 'true' : undefined}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => cancelDrag(event.pointerId)}
        onPointerCancel={(event) => cancelDrag(event.pointerId)}
        onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
      >
        <div ref={stageRef} className={styles.imagePreviewStage}>
          {!!currentObjectUrl && !failed && (
            <img
              ref={imageRef}
              className={styles.imagePreviewImage}
              src={currentObjectUrl}
              alt={fileName}
              draggable={false}
              style={scaledSize ?? undefined}
              onLoad={(event) => {
                setLoadState({
                  data: preview.data,
                  status: 'loaded',
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }}
              onError={() => {
                setLoadState({
                  data: preview.data,
                  status: 'failed',
                  width: 0,
                  height: 0,
                })
              }}
            />
          )}
          {failed && (
            <Text className={styles.imagePreviewStatus} tone="secondary" role="alert">
              {t('workbench.imagePreviewFailed')}
            </Text>
          )}
        </div>
      </div>
      <footer className={styles.imagePreviewFooter}>
        <Text className={styles.imagePreviewMetadata} tone="caption">
          {metadata.join(' · ')}
        </Text>
        {currentLoadState?.status === 'loaded' && (
          <div
            className={styles.imagePreviewToolbar}
            role="group"
            aria-label={t('workbench.imagePreviewToolbar')}
          >
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('workbench.imagePreviewZoomOut')}
              title={t('workbench.imagePreviewZoomOut')}
              disabled={zoom <= WORKBENCH_IMAGE_MIN_MANUAL_ZOOM}
              onClick={() => zoomBy('out')}
            >
              <MinusIcon size={14} weight="bold" />
            </IconButton>
            <output
              className={styles.imagePreviewZoomValue}
              aria-label={t('workbench.imagePreviewZoomLevel')}
            >
              {zoomLabel}
            </output>
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('workbench.imagePreviewZoomIn')}
              title={t('workbench.imagePreviewZoomIn')}
              disabled={zoom >= WORKBENCH_IMAGE_MAX_MANUAL_ZOOM}
              onClick={() => zoomBy('in')}
            >
              <PlusIcon size={14} weight="bold" />
            </IconButton>
            <span className={styles.imagePreviewToolbarDivider} aria-hidden="true" />
            <button
              type="button"
              className={styles.imagePreviewActualSizeButton}
              aria-label={t('workbench.imagePreviewActualSize')}
              aria-pressed={zoomMode === 'manual' && manualZoom === 1}
              title={t('workbench.imagePreviewActualSize')}
              onClick={setActualSize}
            >
              100%
            </button>
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={t('workbench.imagePreviewFit')}
              title={t('workbench.imagePreviewFit')}
              aria-pressed={zoomMode === 'fit'}
              onClick={setFitZoom}
            >
              <CornersInIcon size={14} />
            </IconButton>
          </div>
        )}
      </footer>
    </section>
  )
}
