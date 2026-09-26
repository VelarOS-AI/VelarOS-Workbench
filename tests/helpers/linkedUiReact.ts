import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import * as ReactDom from 'react-dom'
import { mock } from 'bun:test'
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime'
import * as ReactJsxRuntime from 'react/jsx-runtime'

const RepositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

const SharedReactModules: ReadonlyArray<readonly [string, object]> = [
  ['react', React],
  ['react/jsx-runtime', ReactJsxRuntime],
  ['react/jsx-dev-runtime', ReactJsxDevRuntime],
  ['react-dom', ReactDom],
]

/**
 * `@velaros-ai/ui` 链接自本机的 VelarOS-UI 仓，它自己的 node_modules 里另有一份 React。构建时 electron-vite
 * 用 `resolve.dedupe` 让它复用宿主这一份；bun test 没有这一步，UI 包里的 hooks 会落到另一份 React 上，
 * 渲染时报「Invalid hook call」。这里把 UI 包解析到的那几个 React 模块换成宿主这一份。
 *
 * 要在第一次加载 UI 包（以及会间接加载它的宿主模块）之前调用，之后再用动态 import 加载它们——静态 import
 * 在任何代码执行之前就已经解析完了。
 */
export function shareHostReactWithLinkedUi(): void {
  const uiRoot = realpathSync(path.join(RepositoryRoot, 'node_modules/@velaros-ai/ui'))
  const resolveFromHost = createRequire(path.join(RepositoryRoot, 'package.json')).resolve
  const resolveFromUi = createRequire(path.join(uiRoot, 'package.json')).resolve
  for (const [specifier, shared] of SharedReactModules) {
    const uiCopy = resolveFromUi(specifier)
    if (uiCopy !== resolveFromHost(specifier)) void mock.module(uiCopy, () => shared)
  }
}
