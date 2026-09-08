import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { WORKBENCH_CONVERSATION_I18N_CONTRACT_VERSION } from '../src/renderer/src/i18n/messages/conversation'
import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'

const ConversationUiRoot = path.resolve(
  process.cwd(),
  'node_modules/@velaros-ai/ui/dist/conversation',
)

const DynamicConversationKeys = [
  'status.elapsedSeconds',
  'status.elapsedMinutesSeconds',
  'status.elapsedHoursMinutes',
  'status.phasePreparing',
  'status.verification.aborted',
  'status.verification.failed',
  'status.verification.not-run',
  'status.verification.passed',
  'status.verification.stale',
  'status.verification.timed-out',
  'status.verification.unknown',
] as const

void describe('Workbench conversation localization contract', () => {
  void test('requires a localization review when the shared conversation package changes', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'node_modules/@velaros-ai/ui/package.json'), 'utf8'),
    ) as { version?: string }

    assert.equal(manifest.version, WORKBENCH_CONVERSATION_I18N_CONTRACT_VERSION)
  })

  void test('resolves every statically referenced shared conversation key in both locales', () => {
    const keys = readStaticConversationTranslationKeys()
    assert.ok(
      keys.size > 250,
      'shared conversation translation scan unexpectedly found too few keys',
    )

    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const key of [...keys, ...DynamicConversationKeys]) {
        assert.notEqual(
          translateWorkbenchAppMessage(locale, key),
          key,
          `${locale} is missing ${key}`,
        )
      }
    }
  })

  void test('localizes elapsed run time instead of rendering the translation key', () => {
    assert.equal(
      translateWorkbenchAppMessage('zh-CN', 'status.elapsedSeconds', {
        seconds: 7,
      }),
      '7秒',
    )
    assert.equal(
      translateWorkbenchAppMessage('en-US', 'status.elapsedSeconds', {
        seconds: 7,
      }),
      '7s',
    )
  })
})

function readStaticConversationTranslationKeys(): Set<string> {
  const keys = new Set<string>()
  const translationCall = /\bt\(\s*['"`]([^'"`]+)['"`]/gu

  for (const file of listJavaScriptFiles(ConversationUiRoot)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(translationCall)) {
      if (match[1]?.includes('.') && !match[1].includes('${')) keys.add(match[1])
    }
  }

  return keys
}

function listJavaScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolutePath = path.join(root, name)
    return statSync(absolutePath).isDirectory()
      ? listJavaScriptFiles(absolutePath)
      : absolutePath.endsWith('.js')
        ? [absolutePath]
        : []
  })
}
