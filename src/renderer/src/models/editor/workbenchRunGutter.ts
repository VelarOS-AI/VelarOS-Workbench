import { type Extension, RangeSetBuilder } from '@codemirror/state'
import { gutter, GutterMarker } from '@codemirror/view'

import {
  type WorkbenchRunCommand,
  workbenchRunCommandKey,
  type WorkbenchRunSessionLaunchOptions,
} from '../commands/workbenchCommandLines'

export interface WorkbenchRunGutterAction extends WorkbenchRunCommand {
  label: string
  line: number
}

interface WorkbenchRunGutterOptions {
  actions: readonly WorkbenchRunGutterAction[]
  disabled?: boolean
  onRun: (command: string, launch?: WorkbenchRunSessionLaunchOptions) => void
}

class WorkbenchRunMarker extends GutterMarker {
  public constructor(
    private readonly action: WorkbenchRunGutterAction,
    private readonly disabled: boolean,
    private readonly onRun: (command: string, launch?: WorkbenchRunSessionLaunchOptions) => void
  ) {
    super()
  }

  public override eq(other: GutterMarker): boolean {
    return (
      other instanceof WorkbenchRunMarker &&
      other.action.command === this.action.command &&
      workbenchRunCommandKey(other.action.command, other.action.launch) ===
        workbenchRunCommandKey(this.action.command, this.action.launch) &&
      other.action.label === this.action.label &&
      other.disabled === this.disabled
    )
  }

  public override toDOM(): Node {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-workbenchRunButton'
    button.title = this.action.command
    button.setAttribute('aria-label', this.action.command)
    button.disabled = this.disabled
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!this.disabled) this.onRun(this.action.command, this.action.launch)
    })

    const icon = document.createElement('span')
    icon.className = 'cm-workbenchRunIcon'
    icon.setAttribute('aria-hidden', 'true')
    button.append(icon)
    return button
  }
}

export function createWorkbenchRunGutterExtension({
  actions,
  disabled = false,
  onRun,
}: WorkbenchRunGutterOptions): Extension {
  if (actions.length === 0) return []

  return gutter({
    class: 'cm-workbenchRunGutter',
    markers(view) {
      const builder = new RangeSetBuilder<GutterMarker>()
      for (const action of actions) {
        if (action.line > view.state.doc.lines) continue

        const line = view.state.doc.line(action.line)
        builder.add(line.from, line.from, new WorkbenchRunMarker(action, disabled, onRun))
      }
      return builder.finish()
    },
  })
}
