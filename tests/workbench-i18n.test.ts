import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { workbenchAppEnUSMessages } from '../src/renderer/src/i18n/messages/en-US'
import { workbenchAppZhCNMessages } from '../src/renderer/src/i18n/messages/zh-CN'
import { lastOpenedLabel } from '../src/renderer/src/welcome/lastOpenedLabel'

function messageKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    messageKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe('Workbench interface language', () => {
  test('English and Chinese have the same messages', () => {
    const chinese = messageKeys(workbenchAppZhCNMessages).sort()
    const english = messageKeys(workbenchAppEnUSMessages).sort()
    expect(english.filter((key) => !chinese.includes(key))).toEqual([])
    expect(chinese.filter((key) => !english.includes(key))).toEqual([])
  })

  test('the welcome page and the new project dialog take their words from the catalogs', () => {
    for (const file of ['WorkbenchWelcomePage.tsx', 'NewProjectDialog.tsx']) {
      const source = readFileSync(
        path.resolve(process.cwd(), 'src/renderer/src/welcome', file),
        'utf8'
      ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
      expect(source).not.toMatch(/\p{Script=Han}/u)
    }
  })

  test('recent projects show when they were opened in the interface language', () => {
    const now = Date.UTC(2026, 8, 30, 12)
    const minute = 60_000
    const day = 24 * 60 * minute
    expect(lastOpenedLabel(now - 10_000, 'en-US', 'Just now', now)).toBe('Just now')
    expect(lastOpenedLabel(now - 5 * minute, 'en-US', 'Just now', now)).toBe('5 minutes ago')
    expect(lastOpenedLabel(now - 5 * minute, 'zh-CN', '刚刚', now)).toBe('5分钟前')
    expect(lastOpenedLabel(now - day - 60 * minute, 'en-US', 'Just now', now)).toBe('yesterday')
    expect(lastOpenedLabel(now - day - 60 * minute, 'zh-CN', '刚刚', now)).toBe('昨天')
    expect(lastOpenedLabel(now - 10 * day, 'en-US', 'Just now', now)).toBe(
      new Date(now - 10 * day).toLocaleDateString('en-US')
    )
  })
})
