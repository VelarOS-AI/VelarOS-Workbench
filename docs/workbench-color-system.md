# Workbench color system

UI colors have one source: `src/shared/workbenchAppearance.ts`, based on
[`@radix-ui/colors` 3.0.0](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale).
Do not add per-component light/dark hex values or remap the primary color to text ink.

## Foundation and roles

Radix supplies separate twelve-step light and dark scales. Steps 1–2 provide
surfaces, 3–5 interaction fills, 6–8 borders and focus, 9–10 solid fills, and
11–12 readable foregrounds. The selected accent is a color family; its actual
foreground, solid, hover and selected colors adapt to the active mode.

| Role               | Tokens                                                                                                  | Purpose                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Neutral surfaces   | `--workbench-bg`, `--workbench-surface-muted`, `--workbench-surface`                                    | Editor canvas, sidebars, elevated panels                                      |
| Text hierarchy     | `--workbench-text`, `--workbench-text-secondary`, `--workbench-text-muted`, `--workbench-text-disabled` | Main content, supporting content, hints, disabled controls                    |
| Accent ink         | `--workbench-theme-color`, `--workbench-active-fg`                                                      | Selected labels, links, tab indicators                                        |
| Accent fills       | `--workbench-accent-solid`, `--workbench-accent-solid-hover`, `--workbench-accent-contrast`             | Primary actions and their foreground                                          |
| Subtle interaction | `--workbench-hover`, `--workbench-active-soft`, `--workbench-selection-bg`                              | Hover, selected and pressed backgrounds                                       |
| Auxiliary colors   | `--status-green`, `--status-red`, `--status-amber`, `--status-blue`                                     | Success/run, error, warning, information; each has a matching `-soft` surface |
| Test presentation  | `--workbench-test-fg`, `--workbench-run-fg`                                                             | Orange test directories; green test run badges                                |
| Floating content   | `--workbench-tooltip-bg`, `--workbench-tooltip-fg`, `--workbench-tooltip-border`                        | Tooltip content and arrow, including body portals                             |

Light Modern and Dark Modern use Slate neutrals. Warm Paper uses Sand instead
of a yellow/brown wash. Midnight Blue derives a restrained navy neutral scale
from dark Slate and Blue. Alpha overlays, RGB aliases, muted ink, selected states,
and contrast-safe hover colors are calculated centrally from these scales.

Text, accent ink, status text, tooltip content and primary-button foregrounds
are tested at a WCAG contrast ratio of at least 4.5:1 on their intended surfaces.
Disabled decoration is a separate role and does not replace readable hint text.

## Applying and extending themes

`useWorkbenchPreferences` applies the semantic palette and shared UI light/dark
mode to the document root before paint. Shared controls, app surfaces and portals inherit it; CSS Modules must not
redeclare a palette on individual shells or portal scopes. The Settings preview
uses the same factory. Shared component compatibility aliases are mapped in that
factory or derived from these tokens in `01-shell.module.css`. The adapters in
`index.css` replace fixed white tooltip fills and primary-button hover mixing
with the same contrast-checked roles.

The native appearance bridge accepts only known theme IDs from registered app
windows, synchronizes Electron's native light/dark mode, and updates native-window
backgrounds. `native-appearance.json` stores a small startup hint so windows can
use the right appearance before the renderer loads. Renderer preferences remain
authoritative; the native file does not duplicate accent preferences.

To add a theme, choose its neutral scale and color scheme in this module, then
verify every accent family with `tests/workbench-color-system.test.ts` and visually
check hover, selection, menus and tooltips. Add role aliases instead of copying
colors into components. Code syntax and language-specific file icons remain
separate palettes; they identify language roles rather than product action states.
