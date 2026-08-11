import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import { getFilePresentationVariant } from '@velaros-ai/ui/utils/filePresentation'

void describe('VelarScript brand identity', () => {
  void test('uses the standalone V/S mark for .vel files', () => {
    assert.equal(getFilePresentationVariant({ fileName: 'src/main.vel' }), 'velarscript')

    const markup = renderToStaticMarkup(createElement(FileTypeIcon, {
      fileName: 'src/main.vel',
      size: 16,
    }))

    assert.match(markup, /data-velarscript-mark="true"/u)
    assert.doesNotMatch(markup, /<rect\b/u)
  })
})
