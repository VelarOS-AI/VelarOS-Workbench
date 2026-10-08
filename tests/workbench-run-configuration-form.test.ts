import assert from 'node:assert/strict'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import type {
  WorkbenchRunConfigurationDraft,
  WorkbenchRunConfigurationDraftIssues,
} from '../src/renderer/src/models/commands/workbenchRunConfigurationDrafts'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n/WorkbenchLocalizationProvider')
const { WorkbenchRunConfigurationForm } = await import(
  '../src/renderer/src/components/WorkbenchRunConfigurationsDialog'
)

const Draft: WorkbenchRunConfigurationDraft = {
  id: 'run-configuration-dev',
  name: 'API server',
  type: 'command',
  command: 'bun run dev',
  script: '',
  args: '',
  cwd: 'packages/api',
  envText: 'PORT=4100',
}

function renderForm(
  draft: WorkbenchRunConfigurationDraft,
  issues: Nullable<WorkbenchRunConfigurationDraftIssues>
): string {
  return renderToStaticMarkup(
    createElement(WorkbenchLocalizationProvider, {
      value: {
        locale: 'zh-CN',
        setLocale: async () => undefined,
        t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
      },
      children: createElement(WorkbenchRunConfigurationForm, {
        draft,
        issues,
        onChange: () => undefined,
      }),
    })
  )
}

void describe('run configuration form', () => {
  void test('shows the name, command, working directory and variables of a configuration', () => {
    const html = renderForm(Draft, null)
    assert.match(html, /value="API server"/u)
    assert.match(html, /value="bun run dev"/u)
    assert.match(html, /value="packages\/api"/u)
    assert.match(html, />PORT=4100<\/textarea>/u)
    // 没问题时字段下面是说明，不是报错。
    assert.match(html, /workbench\.runConfigurationCwdHint/u)
    assert.match(html, /workbench\.runConfigurationEnvHint/u)
    assert.doesNotMatch(html, /Required|OutsideProject|EnvInvalid/u)
  })

  void test('names what is wrong under each field once a save was refused', () => {
    const html = renderForm(
      { ...Draft, name: '', command: '', cwd: '../up', envText: 'PORT 4100\n1X=2' },
      {
        name: 'required',
        command: 'required',
        cwd: 'outside-project',
        env: [
          { line: 1, text: 'PORT 4100', reason: 'missing-equals' },
          { line: 2, text: '1X=2', reason: 'invalid-name' },
        ],
      }
    )
    assert.match(html, /workbench\.runConfigurationNameRequired/u)
    assert.match(html, /workbench\.runConfigurationCommandRequired/u)
    assert.match(html, /workbench\.runConfigurationCwdOutsideProject/u)
    assert.match(html, /workbench\.runConfigurationEnvInvalidLine\{&quot;line&quot;:1/u)
    assert.match(html, /workbench\.runConfigurationEnvInvalidName\{&quot;line&quot;:2/u)
    assert.doesNotMatch(html, /workbench\.runConfigurationCwdHint|workbench\.runConfigurationEnvHint/u)
    assert.equal(html.match(/aria-invalid="true"/gu)?.length, 4)
  })

  void test('a Node program has a script and arguments instead of a command', () => {
    const node: WorkbenchRunConfigurationDraft = {
      ...Draft,
      type: 'node',
      script: 'src/server.js',
      args: '--port 4100',
    }
    const html = renderForm(node, null)
    // 两个种类都列着，选中的是 Node 程序。
    assert.match(html, /aria-pressed="false"[^>]*>workbench\.runConfigurationTypeCommand/u)
    assert.match(html, /aria-pressed="true"[^>]*>workbench\.runConfigurationTypeNode/u)
    assert.match(html, /value="src\/server\.js"/u)
    assert.match(html, /value="--port 4100"/u)
    assert.match(html, /workbench\.runConfigurationScriptHint/u)
    // 命令那一栏不出现（输入框里的字还留在草稿里，换回命令型时还在）。
    assert.doesNotMatch(html, /value="bun run dev"/u)
    assert.match(renderForm(Draft, null), /value="bun run dev"/u)
    assert.doesNotMatch(renderForm(Draft, null), /runConfigurationScript/u)

    assert.match(
      renderForm({ ...node, script: '' }, { script: 'required' }),
      /workbench\.runConfigurationScriptRequired/u
    )
    assert.match(
      renderForm({ ...node, script: '../up.js' }, { script: 'outside-project' }),
      /workbench\.runConfigurationScriptOutsideProject/u
    )
  })
})
