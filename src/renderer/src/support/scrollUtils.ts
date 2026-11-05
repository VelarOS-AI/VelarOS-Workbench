/** 独立 Workbench 应用副本（desktop `@utils/dom/scroll.utils` 同源）。 */
import { isFunction } from '@velaros-ai/velaros/core'
import { TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

const DEFAULT_SCROLL_INTO_VIEW_OPTIONS: ScrollIntoViewOptions = {
  block: 'start',
  behavior: 'smooth',
}
const scrollTimers = new TimerScope({ name: 'workbench-app.scroll.utils' })

type ScrollIntoViewTarget = LooseOptional<Element> | (() => LooseOptional<Element>)

function resolveScrollTarget(target: ScrollIntoViewTarget): LooseOptional<Element> {
  return isFunction(target) ? target() : target
}

/** 在下一帧调度滚动到可见区域。 */
export function requestScrollIntoView(
  target: ScrollIntoViewTarget,
  options?: ScrollIntoViewOptions
): void {
  const merged: ScrollIntoViewOptions = {
    ...DEFAULT_SCROLL_INTO_VIEW_OPTIONS,
    ...options,
  }

  scrollTimers.nextFrame(() => {
    resolveScrollTarget(target)?.scrollIntoView(merged)
  })
}
