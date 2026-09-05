export const WORKBENCH_IMAGE_MIN_MANUAL_ZOOM = 0.1
export const WORKBENCH_IMAGE_MAX_MANUAL_ZOOM = 8

const WORKBENCH_IMAGE_ZOOM_STEPS = [
  0.1,
  0.125,
  0.25,
  0.33,
  0.5,
  0.67,
  0.75,
  1,
  1.25,
  1.5,
  2,
  2.5,
  3,
  4,
  5,
  6,
  8,
] as const

export type WorkbenchImageZoomDirection = 'in' | 'out'
export type WorkbenchImageZoomShortcutAction = WorkbenchImageZoomDirection | 'actual' | 'fit'

interface WorkbenchImageFitZoomInput {
  naturalWidth: number
  naturalHeight: number
  viewportWidth: number
  viewportHeight: number
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function clampWorkbenchImageManualZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1

  return Math.min(
    WORKBENCH_IMAGE_MAX_MANUAL_ZOOM,
    Math.max(WORKBENCH_IMAGE_MIN_MANUAL_ZOOM, zoom)
  )
}

export function stepWorkbenchImageZoom(
  zoom: number,
  direction: WorkbenchImageZoomDirection
): number {
  const current = Number.isFinite(zoom) ? zoom : 1

  if (direction === 'in') return (
      WORKBENCH_IMAGE_ZOOM_STEPS.find((candidate) => candidate > current + Number.EPSILON)
      ?? WORKBENCH_IMAGE_MAX_MANUAL_ZOOM
    )

  return (
    WORKBENCH_IMAGE_ZOOM_STEPS.findLast((candidate) => candidate < current - Number.EPSILON)
    ?? WORKBENCH_IMAGE_MIN_MANUAL_ZOOM
  )
}

export function canStepWorkbenchImageZoom(
  zoom: number,
  direction: WorkbenchImageZoomDirection
): boolean {
  if (!Number.isFinite(zoom)) return false

  return direction === 'in'
    ? zoom < WORKBENCH_IMAGE_MAX_MANUAL_ZOOM
    : zoom > WORKBENCH_IMAGE_MIN_MANUAL_ZOOM
}

export function resolveWorkbenchImageFitZoom({
  naturalWidth,
  naturalHeight,
  viewportWidth,
  viewportHeight,
}: WorkbenchImageFitZoomInput): number {
  if (
    !positiveFinite(naturalWidth)
    || !positiveFinite(naturalHeight)
    || !positiveFinite(viewportWidth)
    || !positiveFinite(viewportHeight)
  )
    return 1

  return Math.min(1, viewportWidth / naturalWidth, viewportHeight / naturalHeight)
}

export function formatWorkbenchImageZoom(zoom: number): string {
  const percentage = Math.max(0, zoom * 100)
  const rounded = percentage < 10
    ? Math.round(percentage * 10) / 10
    : Math.round(percentage)

  return `${rounded}%`
}

export function resolveWorkbenchImageZoomShortcut(
  key: string,
  modifierActive: boolean
): Nullable<WorkbenchImageZoomShortcutAction> {
  if (modifierActive) return null

  if (key === '+' || key === '=') return 'in'
  if (key === '-') return 'out'
  if (key === '0') return 'actual'
  if (key.toLowerCase() === 'f') return 'fit'

  return null
}

export function resolveWorkbenchImageWheelZoom(
  deltaY: number,
  modifierActive: boolean
): Nullable<WorkbenchImageZoomDirection> {
  if (!modifierActive || deltaY === 0) return null

  return deltaY < 0 ? 'in' : 'out'
}
