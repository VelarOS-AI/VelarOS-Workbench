import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { FileCodeIcon } from '@phosphor-icons/react'

import {
  getWorkbenchFilePresentationVariant,
  registerWorkbenchFileIconContribution,
  resolveWorkbenchFilePresentation,
} from '../src/renderer/src/models/files/workbenchFilePresentation'

void describe('Workbench file icon surface', () => {
  void test('uses product icons for current languages and common project files', () => {
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: '.gitignore' }), 'gitignore')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: '.npmrc' }), 'config')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'bun.lock' }), 'lock')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'package.json' }), 'json')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'change.patch' }), 'patch')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.js' }), 'javascript')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'view.jsx' }), 'jsx')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.ts' }), 'typescript')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'view.tsx' }), 'tsx')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.vel' }), 'velarscript')
  })

  void test('keeps framework-specific icons outside core and exposes a contribution seam', () => {
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'App.vue' }), 'code')
    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'main.py' }), 'code')

    const contribution = {
      id: 'fixture-framework-icons',
      resolve: ({ fileName }: { fileName?: string | null }) =>
        fileName?.endsWith('.vue')
          ? { variant: 'fixture-vue', icon: FileCodeIcon, color: '#42b883' }
          : null,
    }
    const remove = registerWorkbenchFileIconContribution(contribution)
    try {
      assert.deepEqual(resolveWorkbenchFilePresentation({ fileName: 'App.vue' }), {
        variant: 'fixture-vue',
        icon: FileCodeIcon,
        color: '#42b883',
      })
    } finally {
      remove()
    }

    assert.equal(getWorkbenchFilePresentationVariant({ fileName: 'App.vue' }), 'code')
  })
})
