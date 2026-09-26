import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { currentSystemPlatform, getSystemShellKind } from '@velaros-ai/system/platform-compatibility'

import { workbenchCommandEnvironment } from '../src/main/agent/WorkbenchCommandEnvironment'
import { CommandHelper } from '../src/main/workspace/CommandHelper'

test('the provider receives the shell selected by the actual command runner', () => {
  const selected = new CommandHelper().getShellSpec('echo verification')
  const environment = JSON.parse(workbenchCommandEnvironment().split(': ').slice(1).join(': '))
  assert.deepEqual(environment, {
    platform: currentSystemPlatform.getPlatform(),
    shell: {
      kind: getSystemShellKind(selected.file),
      name: currentSystemPlatform.getPathTextBaseName(selected.file),
    },
  })
})
