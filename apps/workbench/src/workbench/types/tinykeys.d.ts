/**
 * tinykeys 类型兜底声明。
 *
 * `tinykeys@3.0.0` 的 `package.json` 在 `exports."."` 里只声明了 `import` / `require`，
 * 没有 `types` 条件；在 `moduleResolution: "bundler"` 下 TypeScript 不再回退到顶层 `types`
 * 字段，于是直接报 TS7016。这里手抄一份与官方 `dist/tinykeys.d.ts` 等价的环境声明，
 * 上游修包后可以直接删本文件。
 */
declare module 'tinykeys' {
  export type KeyBindingPress = [mods: string[], key: string | RegExp]

  export interface KeyBindingMap {
    [keybinding: string]: (event: KeyboardEvent) => void
  }

  export interface KeyBindingHandlerOptions {
    timeout?: number
  }

  export interface KeyBindingOptions extends KeyBindingHandlerOptions {
    event?: 'keydown' | 'keyup'
    capture?: boolean
  }

  export function parseKeybinding(str: string): KeyBindingPress[]

  export function matchKeyBindingPress(
    event: KeyboardEvent,
    press: KeyBindingPress,
  ): boolean

  export function createKeybindingsHandler(
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingHandlerOptions,
  ): EventListener

  export function tinykeys(
    target: Window | HTMLElement,
    keyBindingMap: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void
}
