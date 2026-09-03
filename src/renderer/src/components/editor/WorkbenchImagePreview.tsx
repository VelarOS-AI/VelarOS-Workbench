import { type ReactElement, useEffect, useState } from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'

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

  useEffect(() => {
    const bytes = Uint8Array.from(preview.data)
    const value = URL.createObjectURL(new Blob([bytes], { type: preview.mediaType }))
    setObjectUrl({ data: preview.data, mediaType: preview.mediaType, value })

    return () => URL.revokeObjectURL(value)
  }, [preview.data, preview.mediaType])

  const currentObjectUrl =
    objectUrl?.data === preview.data && objectUrl.mediaType === preview.mediaType
      ? objectUrl.value
      : null
  const currentLoadState = loadState?.data === preview.data ? loadState : null
  const failed = currentLoadState?.status === 'failed'
  const fileName = fileNameFromPath(path)
  const metadata = [
    ImageFormatLabels[preview.mediaType],
    currentLoadState?.status === 'loaded'
      ? `${currentLoadState.width} × ${currentLoadState.height}`
      : null,
    formatByteSize(size),
  ].filter((value): value is string => !!value)

  return (
    <section
      className={styles.imagePreview}
      aria-label={t('workbench.imagePreviewLabel', { name: fileName })}
    >
      <div className={styles.imagePreviewCanvas}>
        {!!currentObjectUrl && !failed && (
          <img
            className={styles.imagePreviewImage}
            src={currentObjectUrl}
            alt={fileName}
            draggable={false}
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
      <Text className={styles.imagePreviewMetadata} tone="caption">
        {metadata.join(' · ')}
      </Text>
    </section>
  )
}
