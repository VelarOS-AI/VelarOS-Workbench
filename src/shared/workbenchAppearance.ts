/** Radix Colors: one palette source for app chrome, shared controls and native windows.
 * Steps 1–2: surfaces; 3–5: interaction fills; 6–8: borders; 9–10: solids; 11–12: ink.
 */
import {
  amber,
  amberDark,
  blue,
  blueDark,
  green,
  greenDark,
  orange,
  orangeDark,
  red,
  redDark,
  ruby as rose,
  rubyDark as roseDark,
  sand,
  sandDark,
  slate,
  slateDark,
  teal,
  tealDark,
  violet,
  violetDark,
} from '@radix-ui/colors'

export type WorkbenchThemeId = 'light-modern' | 'dark-modern' | 'warm-paper' | 'midnight-blue'
export type WorkbenchAccent =
  'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'rose' | 'violet' | 'slate'
export type WorkbenchColorTokens = Record<`--${string}`, string>
type Scale = readonly string[]

function scale(name: string, colors: Record<string, string>): Scale {
  return Array.from({ length: 12 }, (_, index) => colors[`${name}${index + 1}`]!)
}

const palettes = {
  blue: [scale('blue', blue), scale('blue', blueDark)],
  teal: [scale('teal', teal), scale('teal', tealDark)],
  green: [scale('green', green), scale('green', greenDark)],
  amber: [scale('amber', amber), scale('amber', amberDark)],
  orange: [scale('orange', orange), scale('orange', orangeDark)],
  rose: [scale('ruby', rose), scale('ruby', roseDark)],
  violet: [scale('violet', violet), scale('violet', violetDark)],
  slate: [scale('slate', slate), scale('slate', slateDark)],
  red: [scale('red', red), scale('red', redDark)],
  sand: [scale('sand', sand), scale('sand', sandDark)],
} as const

export function isWorkbenchTheme(value: unknown): value is WorkbenchThemeId {
  return (
    value === 'light-modern' ||
    value === 'dark-modern' ||
    value === 'warm-paper' ||
    value === 'midnight-blue'
  )
}

export function isWorkbenchDarkTheme(theme: WorkbenchThemeId): boolean {
  return theme === 'dark-modern' || theme === 'midnight-blue'
}

function channels(color: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

/** Small palette variations are derived here, never in individual components. */
function mix(first: string, second: string, amount: number): string {
  const other = channels(second)
  return `#${channels(first)
    .map((channel, index) =>
      Math.round(channel * (1 - amount) + other[index]! * amount)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function alpha(color: string, opacity: number): string {
  return `${color}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')}`
}

function luminance(color: string): number {
  const linear = channels(color).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

export function workbenchColorContrast(first: string, second: string): number {
  const light = luminance(first)
  const dark = luminance(second)
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
}

function readable(colors: readonly string[], backgrounds: readonly string[]): string {
  return (
    colors.find((color) =>
      backgrounds.every((background) => workbenchColorContrast(color, background) >= 4.5)
    ) ?? colors.at(-1)!
  )
}

function readableSurface(background: string, foreground: string): string {
  const target = luminance(foreground) > 0.5 ? '#000000' : '#ffffff'
  for (let amount = 0; amount <= 1; amount += 0.04) {
    const candidate = mix(background, target, amount)
    if (workbenchColorContrast(candidate, foreground) >= 4.5) return candidate
  }
  return target
}

function readableInk(colors: Scale, backgrounds: readonly string[]): string {
  return readable(
    Array.from({ length: 21 }, (_, index) => mix(colors[10]!, colors[11]!, index / 20)),
    backgrounds
  )
}

function neutralScale(theme: WorkbenchThemeId): Scale {
  if (theme === 'warm-paper') return palettes.sand[0]
  if (theme === 'midnight-blue')
    return palettes.slate[1].map((color, index) =>
      mix(color, palettes.blue[1][index]!, index < 8 ? 0.34 : 0.1)
    )
  return palettes.slate[isWorkbenchDarkTheme(theme) ? 1 : 0]
}

export function getWorkbenchNativeAppearance(theme: WorkbenchThemeId): {
  colorScheme: 'light' | 'dark'
  backgroundColor: string
} {
  return {
    colorScheme: isWorkbenchDarkTheme(theme) ? 'dark' : 'light',
    backgroundColor:
      neutralScale(theme)[isWorkbenchDarkTheme(theme) || theme === 'warm-paper' ? 1 : 0]!,
  }
}

export function getWorkbenchColorTokens(
  theme: WorkbenchThemeId,
  accent: WorkbenchAccent
): WorkbenchColorTokens {
  const dark = isWorkbenchDarkTheme(theme)
  const mode = dark ? 1 : 0
  const neutral = neutralScale(theme)
  const color = palettes[accent][mode]
  const background = getWorkbenchNativeAppearance(theme).backgroundColor
  const panel = neutral[theme === 'warm-paper' ? 2 : dark ? 0 : 1]!
  const hover = neutral[theme === 'warm-paper' ? 3 : 2]!
  const elevated = dark ? neutral[2]! : '#ffffff'
  const ink = neutral[11]!
  const secondary = neutral[10]!
  const muted = readable(
    [...Array.from({ length: 11 }, (_, index) => mix(neutral[9]!, secondary, index / 10)), ink],
    [background, panel, neutral[2]!]
  )
  const accentInk = readableInk(color, [background, panel, color[3]!])
  const solid = color[dark ? 8 : 10]!
  const onSolid = readable(['#ffffff', '#111113'], [solid])
  const solidHover = readableSurface(color[dark ? 9 : 11]!, onSolid)
  const danger = palettes.red[mode][dark ? 8 : 10]!
  const tokens: WorkbenchColorTokens = {
    '--workbench-bg': background,
    '--workbench-surface': elevated,
    '--workbench-surface-muted': panel,
    '--workbench-toolbar': panel,
    '--workbench-control-bg': neutral[2]!,
    '--workbench-border': neutral[5]!,
    '--workbench-border-soft': neutral[4]!,
    '--workbench-seam': neutral[5]!,
    '--workbench-seam-strong': neutral[6]!,
    '--workbench-card-border': neutral[5]!,
    '--workbench-hover': hover,
    '--workbench-text': ink,
    '--workbench-text-secondary': secondary,
    '--workbench-text-muted': muted,
    '--workbench-text-disabled': neutral[8]!,
    '--workbench-theme-color': accentInk,
    '--workbench-theme-color-rgb': channels(accentInk).join(', '),
    '--workbench-accent-solid': solid,
    '--workbench-accent-solid-hover': solidHover,
    '--workbench-accent-contrast': onSolid,
    '--workbench-active': color[3]!,
    '--workbench-active-soft': color[2]!,
    '--workbench-active-fg': accentInk,
    '--workbench-focus': color[7]!,
    '--workbench-focus-inset-ring': alpha(color[7]!, 0.65),
    '--workbench-tab-accent-line': accentInk,
    '--workbench-selection-bg': color[3]!,
    '--workbench-selection-inactive': neutral[3]!,
    '--workbench-selection-secondary-bg': neutral[2]!,
    '--chrome-rail-selected-bg': color[3]!,
    '--chrome-rail-hover-bg': hover,
    '--workbench-tooltip-bg': dark ? neutral[3]! : elevated,
    '--workbench-tooltip-fg': ink,
    '--workbench-tooltip-border': neutral[6]!,
    '--workbench-overlay-shadow': `0 8px 24px ${alpha('#000000', dark ? 0.3 : 0.12)}`,
    '--workbench-editor-bg': background,
    '--workbench-editor-fg': ink,
    '--workbench-editor-muted': muted,
    '--workbench-editor-gutter-bg': background,
    '--workbench-editor-gutter-border': neutral[4]!,
    '--workbench-editor-active-line': alpha(ink, dark ? 0.035 : 0.025),
    '--workbench-editor-active-gutter': neutral[2]!,
    '--workbench-editor-selection': alpha(accentInk, dark ? 0.25 : 0.16),
    '--workbench-editor-occurrence-match': alpha(accentInk, 0.12),
    '--workbench-editor-occurrence-match-active': alpha(accentInk, 0.25),
    '--workbench-editor-caret': ink,
    '--workbench-editor-tooltip-bg': dark ? neutral[3]! : elevated,
    '--workbench-editor-unused-fg': muted,
    '--workbench-tree-ignored-fg': muted,
    '--workbench-folder-fg': dark ? muted : neutral[8]!,
    '--foreground': ink,
    '--background': background,
    '--background-panel': panel,
    '--background-elevated': elevated,
    '--background-panel-strong': elevated,
    '--background-muted': hover,
    '--background-muted-strong': neutral[2]!,
    '--card': elevated,
    '--card-foreground': ink,
    '--popover': elevated,
    '--popover-foreground': ink,
    '--muted': hover,
    '--muted-foreground': muted,
    '--secondary': neutral[2]!,
    '--secondary-foreground': ink,
    '--accent': hover,
    '--accent-foreground': ink,
    '--border': neutral[5]!,
    '--border-strong': neutral[6]!,
    '--input': neutral[6]!,
    '--ring': alpha(color[7]!, 0.4),
    '--destructive': danger,
    '--destructive-foreground': readable(['#ffffff', '#111113'], [danger]),
    '--foreground-secondary': secondary,
    '--foreground-tertiary': muted,
    '--primary': solid,
    '--velar-primary': solid,
    '--velar-primary-rgb': channels(solid).join(', '),
    '--velar-accent': accentInk,
    '--velar-accent-rgb': channels(accentInk).join(', '),
    '--primary-rgb': channels(solid).join(', '),
    '--primary-foreground': onSolid,
    '--control-checked': solid,
    '--control-checked-rgb': channels(solid).join(', '),
    '--control-switch-checked': solid,
    '--control-switch-checked-hover': solidHover,
    '--control-themed-bg': neutral[2]!,
    '--control-themed-hover-bg': neutral[3]!,
    '--control-themed-open-bg': color[3]!,
    '--control-themed-disabled-bg': panel,
    '--control-gray-bg': neutral[2]!,
    '--control-gray-hover-bg': neutral[3]!,
    '--control-gray-inset-hover-bg': elevated,
    '--control-checked-surface': color[2]!,
    '--control-checked-border': color[6]!,
    '--control-themed-border': neutral[6]!,
  }
  for (const name of [
    'blue',
    'teal',
    'green',
    'amber',
    'orange',
    'rose',
    'violet',
    'slate',
    'red',
  ] as const) {
    const status = palettes[name][mode]
    const foreground = readableInk(status, [background, panel, status[2]!, color[3]!])
    tokens[`--status-${name}`] = foreground
    tokens[`--status-${name}-rgb`] = channels(foreground).join(', ')
    tokens[`--status-${name}-soft`] = status[2]!
    tokens[`--status-${name}-surface`] = status[2]!
    tokens[`--status-${name}-strong`] = status[11]!
    tokens[`--status-${name}-strong-rgb`] = channels(status[11]!).join(', ')
    tokens[`--status-${name}-contrast`] = foreground
    tokens[`--status-${name}-contrast-rgb`] = channels(foreground).join(', ')
    tokens[`--status-${name}-muted`] = status[8]!
    tokens[`--status-${name}-muted-rgb`] = channels(status[8]!).join(', ')
    tokens[`--workbench-accent-${name}`] = foreground
    tokens[`--workbench-accent-${name}-contrast`] = readable(['#ffffff', '#111113'], [foreground])
  }
  tokens['--workbench-test-fg'] = tokens['--status-orange']!
  // Technology identity keeps its hue while icon ink follows readable light/dark scales.
  const fileFamilies = {
    java: 'orange',
    csharp: 'violet',
    go: 'teal',
    rust: 'orange',
    vue: 'green',
    dart: 'blue',
    swift: 'orange',
    kotlin: 'violet',
    webassembly: 'violet',
    glsl: 'teal',
    python: 'blue',
    html: 'orange',
    sql: 'blue',
    c: 'blue',
    cpp: 'blue',
    shell: 'green',
    javascript: 'amber',
    typescript: 'blue',
    tsx: 'blue',
    jsx: 'blue',
    css: 'rose',
    scss: 'rose',
    sass: 'rose',
    less: 'blue',
    json: 'amber',
    markdown: 'blue',
    yaml: 'rose',
    velarscript: 'blue',
    config: 'amber',
    lock: 'violet',
    patch: 'teal',
  } as const
  for (const [name, family] of Object.entries(fileFamilies))
    tokens[`--workbench-file-${name}`] = tokens[`--status-${family}`]!
  tokens['--workbench-run-fg'] = tokens['--status-green']!
  tokens['--status-blue-selection-bg'] = palettes.blue[mode][3]!
  tokens['--status-blue-selection-inactive'] = neutral[3]!
  tokens['--status-emerald'] = tokens['--status-teal']!
  tokens['--status-emerald-soft'] = tokens['--status-teal-soft']!
  tokens['--workbench-editor-git-added'] = tokens['--status-green']!
  tokens['--workbench-editor-git-modified'] = tokens['--status-teal']!
  tokens['--workbench-editor-git-deleted'] = tokens['--status-red']!
  return tokens
}
