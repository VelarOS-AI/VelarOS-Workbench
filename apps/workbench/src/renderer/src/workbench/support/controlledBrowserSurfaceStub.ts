/**
 * 独立 Workbench 应用的受控浏览器面空实现（对位 `@velaros-ai/browser-composition` 的
 * `useControlledBrowserSurface`，契约形状同源）。
 *
 * Desktop 由 browser 簇提供 agent 浏览器调试面；独立应用没有内嵌浏览器宿主，
 * 恒返回 inactive surface——编辑区的 agent-browser 调试选项卡因 `active === false`
 * 永不出现。Phase 3 若接入浏览器面，换回真 Provider 即可（输入/输出契约一致）。
 */
import type { ReactNode } from 'react'

import type { BrowserElementSelection } from '@velaros-ai/core/types'

export interface ControlledBrowserSurfaceInput {
  sessionId: string
  workspaceRefreshKey: number
  activationToken: Nullable<string>
}

export interface ControlledBrowserSurfaceRenderOptions {
  onElementPicked: (selection: BrowserElementSelection) => void
  onRequestClose: () => void
}

export interface ControlledBrowserSurface {
  readonly sessionId: string
  readonly active: boolean
  readonly activationToken: Nullable<string>
  readonly page: {
    readonly url: Nullable<string>
    readonly title: string
  }
  readonly render: (options: ControlledBrowserSurfaceRenderOptions) => ReactNode
}

export function useControlledBrowserSurface(
  input: ControlledBrowserSurfaceInput
): ControlledBrowserSurface {
  return {
    sessionId: input.sessionId,
    active: false,
    activationToken: null,
    page: { url: null, title: '' },
    render: () => null,
  }
}
