import {
  WorkbenchAgentEnginesModId,
  WorkbenchAgentEnginesModVersion,
} from './identity'

const WorkbenchAgentEnginesModPermissions = ['process:exec', 'agent:execute'] as const

export const WorkbenchAgentEnginesModManifest = Object.freeze({
  id: WorkbenchAgentEnginesModId,
  version: WorkbenchAgentEnginesModVersion,
  publisher: 'VelarOS',
  displayName: 'Agent Engines',
  description: 'Use the local Claude and ChatGPT command-line login sessions in Workbench.',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  permissions: WorkbenchAgentEnginesModPermissions,
  requiredAxes: [],
  contributes: {
    rightToolWindows: ['claude', 'chatgpt'],
  },
})
