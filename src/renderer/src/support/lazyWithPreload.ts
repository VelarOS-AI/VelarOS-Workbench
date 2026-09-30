import { type ComponentType, lazy, type LazyExoticComponent } from 'react'

export type PreloadableComponent<P extends object> = LazyExoticComponent<ComponentType<P>> & {
  /** 先把模块拉下来（重复调用共用一次加载）；加载失败了下次再试。 */
  preload: () => Promise<ComponentType<P>>
}

/**
 * 不进工作区外壳包的组件：第一次渲染时才加载（要包在 Suspense 里），也可以在窗口空闲时先 preload，第一次打开不用等。
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<ComponentType<P>>
): PreloadableComponent<P> {
  let pending: Nullable<Promise<ComponentType<P>>> = null
  const preload = (): Promise<ComponentType<P>> => {
    pending ??= load().catch((error: unknown) => {
      pending = null
      throw error
    })
    return pending
  }
  return Object.assign(
    lazy(async () => ({ default: await preload() })),
    { preload }
  )
}

/** 窗口空闲时把这些组件的模块先加载好；返回取消函数（给 useEffect 用）。 */
export function preloadWhenIdle(
  components: ReadonlyArray<{ preload: () => Promise<unknown> }>
): () => void {
  if (!window.requestIdleCallback) return () => undefined
  const handle = window.requestIdleCallback(() => {
    for (const component of components) void component.preload().catch(() => undefined)
  })
  return () => window.cancelIdleCallback(handle)
}
