import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, test } from 'bun:test'

import {
  normalizeWorkbenchInternalBrowserUrl,
  prepareWorkbenchWebviewAttachment,
} from '../src/main/projects/WorkbenchWebviewSecurity'
import { normalizeWorkbenchBrowserPageUrl } from '../src/shared/workbenchBrowser'

void describe('Workbench internal browser security', () => {
  void test('accepts only ordinary web destinations', () => {
    assert.equal(normalizeWorkbenchInternalBrowserUrl('http://127.0.0.1:7173'), 'http://127.0.0.1:7173/')
    assert.equal(normalizeWorkbenchInternalBrowserUrl('https://example.com/path'), 'https://example.com/path')
    assert.equal(normalizeWorkbenchInternalBrowserUrl('about:blank'), 'about:blank')
    assert.equal(normalizeWorkbenchInternalBrowserUrl('file:///tmp/private'), null)
    assert.equal(normalizeWorkbenchInternalBrowserUrl('javascript:alert(1)'), null)
    assert.equal(normalizeWorkbenchInternalBrowserUrl('https://user:secret@example.com'), null)
    assert.equal(normalizeWorkbenchInternalBrowserUrl('https://example.com/\nunsafe'), null)
    assert.equal(normalizeWorkbenchBrowserPageUrl('data:text/html,private'), null)
    assert.equal(normalizeWorkbenchBrowserPageUrl('about:blank'), 'about:blank')
  })

  void test('pins the partition and hardens guest preferences before attach', () => {
    const preferences = {
      preload: '/tmp/injected.cjs',
      preloadURL: 'file:///tmp/injected.cjs',
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    }
    assert.equal(prepareWorkbenchWebviewAttachment(preferences, {
      src: 'about:blank',
      partition: 'persist:velaros-workbench-browser',
    }), true)
    assert.equal('preload' in preferences, false)
    assert.equal('preloadURL' in preferences, false)
    assert.deepEqual(preferences, {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
  })

  void test('rejects foreign partitions and privileged startup URLs', () => {
    assert.equal(prepareWorkbenchWebviewAttachment({}, {
      src: 'about:blank',
      partition: 'persist:foreign',
    }), false)
    assert.equal(prepareWorkbenchWebviewAttachment({}, {
      src: 'file:///tmp/private',
      partition: 'persist:velaros-workbench-browser',
    }), false)
  })

  void test('localizes the internal browser load failure title', () => {
    const panel = readFileSync(
      new URL('../src/renderer/src/components/editor/WorkbenchWebviewDebugPanel.tsx', import.meta.url),
      'utf8'
    )
    assert.match(panel, /t\('workbench\.debugPageUnavailable'\)/u)
    assert.match(panel, /normalizeWorkbenchBrowserPageUrl\(candidate\)/u)
    assert.match(panel, /webview\.loadURL\(normalized\)/u)
    assert.match(panel, /failedLoad\?\.url \|\| currentUrl \|\| addressDraft/u)
    assert.doesNotMatch(panel, />页面暂时无法访问</u)
  })
})
