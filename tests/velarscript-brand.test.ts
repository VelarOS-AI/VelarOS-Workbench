import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { getFilePresentationVariant } from '@velaros-ai/ui/utils/filePresentation'

import { WorkbenchFileTypeIcon } from '../src/renderer/src/components/files/WorkbenchFileTypeIcon'

void describe('VelarScript brand identity', () => {
  void test('uses a black VS file icon matching the JS and TS icon family for .vel files', () => {
    assert.equal(getFilePresentationVariant({ fileName: 'src/main.vel' }), 'velarscript')

    const markup = renderToStaticMarkup(createElement(WorkbenchFileTypeIcon, {
      fileName: 'src/main.vel',
      size: 16,
    }))

    assert.match(markup, /data-velarscript-mark="vs"/u)
    assert.match(markup, /<svg\b/u)
    assert.match(markup, /fill="#171717"/u)
    assert.match(markup, /m36 152 24 56 24-56/u)
    assert.doesNotMatch(markup, /<span\b/u)
  })
})
