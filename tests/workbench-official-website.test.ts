import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  resolveVelarOSOfficialWebsiteMarket,
  resolveVelarOSOfficialWebsiteOrigin,
  resolveVelarOSOfficialWebsiteUrl,
} from '../src/main/VelarOSOfficialWebsite'

void describe('Workbench official website routing', () => {
  void test('selects the release market once instead of hardcoding links at call sites', () => {
    assert.equal(
      resolveVelarOSOfficialWebsiteMarket({
        configuredMarket: 'auto',
        locale: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      }),
      'cn'
    )
    assert.equal(
      resolveVelarOSOfficialWebsiteMarket({
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
      }),
      'global'
    )
  })

  void test('keeps Chinese and international account sources on different domains', () => {
    assert.equal(resolveVelarOSOfficialWebsiteOrigin('global', 'cn'), 'https://velaros.cn')
    assert.equal(resolveVelarOSOfficialWebsiteOrigin('cn', 'en'), 'https://global.velaros.cn')
    assert.equal(
      resolveVelarOSOfficialWebsiteUrl('global', '/account', 'cn'),
      'https://velaros.cn/account'
    )
  })
})
