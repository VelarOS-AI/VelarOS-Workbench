import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, test } from 'bun:test'

describe('Workbench Browser composition adapter', () => {
  test('projects the main-process Browser session into the controlled surface', () => {
    const source = readFileSync(
      new URL(
        '../src/renderer/src/browser/standaloneBrowserCompositionAdapter.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(source, /velarosWorkbenchBrowser\.getState/u)
    assert.match(source, /velarosWorkbenchBrowser\.onChanged/u)
    assert.match(source, /active: currentState\?\.active === true/u)
    assert.match(source, /currentState\.generation/u)
    assert.match(source, /activeSessionRef\.current !== input\.sessionId/u)
    assert.match(source, /if \(!disposed\) acceptAuthoritativeState\(next\)/u)
    assert.doesNotMatch(source, /input\.activationToken/u)
  })

  test('hands the shared webview to main without mirroring navigation state', () => {
    const source = readFileSync(
      new URL(
        '../src/renderer/src/browser/standaloneBrowserCompositionAdapter.tsx',
        import.meta.url
      ),
      'utf8'
    )

    assert.match(source, /<WorkbenchWebviewDebugPanel/u)
    assert.match(source, /onWebContentsReady=\{handleWebContentsReady\}/u)
    assert.match(source, /velarosWorkbenchBrowser\.presentPage/u)
    assert.doesNotMatch(source, /onNavigate=/u)
    assert.doesNotMatch(source, /Close browser session/u)

    const embeddedAdapter = readFileSync(
      new URL(
        '../src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(embeddedAdapter, /velarosWorkbenchBrowser\.closeSession\(\{ sessionId \}\)/u)
    assert.match(
      embeddedAdapter,
      /\.then\(\(\) => editorNavigation\.debug\.agentBrowser\.close\(sessionId\)\)/u
    )
    assert.doesNotMatch(embeddedAdapter, /\.finally\(editorNavigation\.debug\.agentBrowser\.close/u)
  })

  test('opens the Agent Browser only when the authoritative active session changes', () => {
    const pageModel = readFileSync(
      new URL('../src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', import.meta.url),
      'utf8'
    )

    assert.match(
      pageModel,
      /\[agentBrowserBindingSessionId, closeAgentBrowserTab, openAgentBrowserTab\]/u
    )
    assert.doesNotMatch(
      pageModel,
      /\[[^\]]*agentBrowser\.activationToken[^\]]*\]/u
    )

    const navigationState = readFileSync(
      new URL(
        '../src/renderer/src/hooks/useWorkbenchEditorNavigationState.ts',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(
      navigationState,
      /if \(expectedSessionId && sessionId !== expectedSessionId\) return sessionId/u
    )
  })

  test('gates internal Browser surfaces behind the bundled Mod state', () => {
    const pageModel = readFileSync(
      new URL('../src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', import.meta.url),
      'utf8'
    )
    assert.match(pageModel, /useStandaloneWorkbenchModCatalog\(\)/u)
    assert.match(
      pageModel,
      /findWorkbenchBrowserMod\(workbenchMods\.value\)\?\.enabled === true/u
    )
    assert.match(
      pageModel,
      /\{ \.\.\.controlledAgentBrowser, active: false, activationToken: null \}/u
    )

    const presentation = readFileSync(
      new URL('../src/renderer/src/StandaloneWorkbenchPagePresentation.tsx', import.meta.url),
      'utf8'
    )
    assert.match(
      presentation,
      /model\.browserModEnabled \? editorNavigation\.debug\.openTab : undefined/u
    )

    const embeddedAdapter = readFileSync(
      new URL(
        '../src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(
      embeddedAdapter,
      /tabs: model\.browserModEnabled \? editorNavigation\.debug\.tabs : \[\]/u
    )
    assert.match(
      embeddedAdapter,
      /agentBrowser: model\.browserModEnabled && model\.agentBrowser\.active/u
    )

    const navigationState = readFileSync(
      new URL(
        '../src/renderer/src/hooks/useWorkbenchEditorNavigationState.ts',
        import.meta.url
      ),
      'utf8'
    )
    assert.match(navigationState, /if \(!browserEnabled\) return/u)
    assert.match(navigationState, /if \(!browserEnabled\) closeAllBrowserTabs\(\)/u)
  })
})
