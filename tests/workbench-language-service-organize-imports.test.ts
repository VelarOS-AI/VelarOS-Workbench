import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  buildWorkbenchCodeMirrorChanges,
  partitionWorkbenchCodeActionChanges,
} from '../src/renderer/src/models/editor/workbenchCodeActions'

import { applyFileEdits, createLanguageProject, StrictTsconfig } from './helpers/languageProject'

const Files = {
  'tsconfig.json': StrictTsconfig,
  'src/util/alpha.ts': 'export const alpha = 1\nexport const another = 2\n',
  'src/util/zeta.ts': 'export const zeta = 1\n',
  'src/util/unused.ts': 'export const unused = 1\n',
}

void describe('organize imports', () => {
  void test('sorts, merges and drops unused imports of the text in the request', async () => {
    const onDisk = "import { zeta } from './util/zeta'\n\nexport const value = zeta\n"
    const edited = [
      "import { zeta } from './util/zeta'",
      "import { unused } from './util/unused'",
      "import { another } from './util/alpha'",
      "import { alpha } from './util/alpha'",
      '',
      'export const total = zeta + alpha + another',
      '',
    ].join('\n')
    const organized = [
      "import { alpha, another } from './util/alpha'",
      "import { zeta } from './util/zeta'",
      '',
      'export const total = zeta + alpha + another',
      '',
    ].join('\n')
    const project = await createLanguageProject({ ...Files, 'src/main.ts': onDisk })
    try {
      // 编辑器里还没保存的正文才是要整理的，不是磁盘上那份。
      const request = { projectRoot: project.projectRoot, path: 'src/main.ts', content: edited }
      const result = await project.services.getOrganizeImports(request)
      assert.deepEqual(result.changes.map((change) => change.path), ['src/main.ts'])
      assert.equal(applyFileEdits(edited, 'src/main.ts', result.changes), organized)

      // 编辑器套这份改动的那条路得到同样的正文（一次改动，一步撤销）。
      const state = EditorState.create({ doc: edited })
      const changes = buildWorkbenchCodeMirrorChanges(
        state,
        partitionWorkbenchCodeActionChanges('src/main.ts', result.changes).current
      )
      assert.ok(changes)
      assert.equal(state.update({ changes }).state.doc.toString(), organized)

      // 已经整理好的文件没有改动。
      const again = await project.services.getOrganizeImports({ ...request, content: organized })
      assert.deepEqual(again.changes, [])
    } finally {
      await project.dispose()
    }
  })

  void test('keeps the quotes and semicolons the file uses', async () => {
    const content = [
      'import { zeta } from "./util/zeta";',
      'import { alpha } from "./util/alpha";',
      '',
      'export const total = zeta + alpha;',
      '',
    ].join('\n')
    const project = await createLanguageProject({ ...Files, 'src/main.ts': content })
    try {
      const result = await project.services.getOrganizeImports({
        projectRoot: project.projectRoot,
        path: 'src/main.ts',
        content,
      })
      assert.equal(
        applyFileEdits(content, 'src/main.ts', result.changes),
        [
          'import { alpha } from "./util/alpha";',
          'import { zeta } from "./util/zeta";',
          '',
          'export const total = zeta + alpha;',
          '',
        ].join('\n')
      )
    } finally {
      await project.dispose()
    }
  })

  void test('is only done by the TypeScript service', async () => {
    const project = await createLanguageProject({ 'notes.md': '# notes\n', 'main.py': 'import os\nimport abc\n' })
    try {
      for (const path of ['notes.md', 'main.py']) {
        const result = await project.services.getOrganizeImports({ projectRoot: project.projectRoot, path })
        assert.deepEqual(result.changes, [], path)
      }
    } finally {
      await project.dispose()
    }
  })
})
