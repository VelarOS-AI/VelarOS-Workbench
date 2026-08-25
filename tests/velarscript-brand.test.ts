import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkbenchFileTypeIcon } from '../src/renderer/src/components/files/WorkbenchFileTypeIcon'
import { getWorkbenchFilePresentationVariant } from '../src/renderer/src/models/files/workbenchFilePresentation'

void describe('VelarScript brand identity', () => {
  void test('uses the VelarScript theme color for .vel file icons', () => {
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'src/main.vel' }), 'velarscript')

    const markup = renderToStaticMarkup(createElement(WorkbenchFileTypeIcon, {
      fileName: 'src/main.vel',
      size: 16,
    }))

    assert.match(markup, /data-velarscript-mark="vs"/u)
    assert.match(markup, /<svg\b/u)
    assert.match(markup, /fill="var\(--workbench-file-velarscript\)"/u)
    assert.match(markup, /m36 152 24 56 24-56/u)
    assert.doesNotMatch(markup, /<span\b/u)
  })
})
