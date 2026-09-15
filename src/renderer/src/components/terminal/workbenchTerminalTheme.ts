import type { ITheme } from '@xterm/xterm'

/**
 * 把任何 CSS 颜色（含 oklch()、var() 链）折成 xterm 认得的 #rrggbb[aa]：画到 1×1 画布上读像素。
 * xterm 自己只认 hex / rgb()，而工作台的调色板经 Tailwind 大多是 oklch。
 */
function createCssColorResolver(): (value: string, fallback: string) => string {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const cache = new Map<string, string>()
  const sentinel = '#010203'

  return (value, fallback) => {
    const trimmed = value.trim()
    if (!trimmed || !context) return fallback
    const cached = cache.get(trimmed)
    if (cached) return cached

    context.fillStyle = sentinel
    context.fillStyle = trimmed
    if (context.fillStyle === sentinel && trimmed.toLowerCase() !== sentinel) return fallback
    context.clearRect(0, 0, 1, 1)
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0, alpha = 255] = context.getImageData(0, 0, 1, 1).data
    const channel = (component: number): string => component.toString(16).padStart(2, '0')
    const hex = `#${channel(red)}${channel(green)}${channel(blue)}${alpha < 255 ? channel(alpha) : ''}`
    cache.set(trimmed, hex)
    return hex
  }
}

/** 按宿主元素此刻的主题变量算 xterm 配色：换主题时重算一次即可。 */
export function buildWorkbenchTerminalTheme(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element)
  const resolve = createCssColorResolver()
  const variable = (name: string, fallback: string): string =>
    resolve(styles.getPropertyValue(name), fallback)

  const background = variable('--workbench-surface', '#1f1f1f')
  const foreground = variable('--foreground', '#d8dee9')
  const black = variable('--workbench-terminal-ansi-black', '#202124')
  const red = variable('--workbench-terminal-ansi-red', '#bc3f3c')
  const green = variable('--workbench-terminal-ansi-green', '#067d17')
  const yellow = variable('--workbench-terminal-ansi-yellow', '#a04b00')
  const blue = variable('--workbench-terminal-ansi-blue', '#2456b3')
  const magenta = variable('--workbench-terminal-ansi-magenta', '#a31574')
  const cyan = variable('--workbench-terminal-ansi-cyan', '#007f73')
  const white = variable('--workbench-terminal-ansi-white', '#5c6b82')
  const brightBlack = variable('--workbench-terminal-ansi-bright-black', black)

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: `${blue.slice(0, 7)}66`,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  }
}

export function readWorkbenchTerminalFontFamily(element: HTMLElement): string {
  return (
    getComputedStyle(element).getPropertyValue('--font-mono').trim()
    || 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  )
}
