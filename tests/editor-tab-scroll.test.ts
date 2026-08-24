import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  resolveActiveEditorTabScroll,
  resolveEditorTabWheelScroll,
} from '../src/renderer/src/hooks/useWorkbenchEditorTabOverflow'

void describe('editor tab horizontal scrolling', () => {
  void test('uses the dominant horizontal trackpad axis instead of a conflicting vertical delta', () => {
    assert.equal(
      resolveEditorTabWheelScroll({
        scrollLeft: 400,
        scrollWidth: 1200,
        clientWidth: 600,
        deltaX: 42,
        deltaY: -7,
        deltaMode: 0,
      }),
      442
    )
  })

  void test('clamps repeated rightward scrolling at the right edge without reversing', () => {
    const input = {
      scrollWidth: 1200,
      clientWidth: 600,
      deltaX: 48,
      deltaY: 3,
      deltaMode: 0,
    }

    assert.equal(resolveEditorTabWheelScroll({ ...input, scrollLeft: 590 }), 600)
    assert.equal(resolveEditorTabWheelScroll({ ...input, scrollLeft: 600 }), 600)
  })

  void test('maps an ordinary vertical wheel to horizontal movement and clamps both edges', () => {
    const input = {
      scrollWidth: 900,
      clientWidth: 500,
      deltaX: 0,
      deltaMode: 0,
    }

    assert.equal(resolveEditorTabWheelScroll({ ...input, scrollLeft: 120, deltaY: 30 }), 150)
    assert.equal(resolveEditorTabWheelScroll({ ...input, scrollLeft: 10, deltaY: -30 }), 0)
  })

  void test('does nothing when the tab row does not overflow', () => {
    assert.equal(
      resolveEditorTabWheelScroll({
        scrollLeft: 0,
        scrollWidth: 500,
        clientWidth: 500,
        deltaX: 20,
        deltaY: 0,
        deltaMode: 0,
      }),
      null
    )
  })

  void test('reveals a newly selected tab on either side of the visible tab range', () => {
    const viewport = { scrollWidth: 1200, clientWidth: 500 }

    assert.equal(resolveActiveEditorTabScroll({
      ...viewport,
      scrollLeft: 400,
      tabStart: 180,
      tabWidth: 120,
    }), 180)
    assert.equal(resolveActiveEditorTabScroll({
      ...viewport,
      scrollLeft: 200,
      tabStart: 760,
      tabWidth: 140,
    }), 400)
  })

  void test('preserves the current tab scroll when the selected tab is already visible', () => {
    assert.equal(resolveActiveEditorTabScroll({
      scrollLeft: 240,
      scrollWidth: 1200,
      clientWidth: 500,
      tabStart: 360,
      tabWidth: 140,
    }), null)
  })

  void test('clamps active-tab following to the real tab row edges', () => {
    assert.equal(resolveActiveEditorTabScroll({
      scrollLeft: 500,
      scrollWidth: 1000,
      clientWidth: 400,
      tabStart: 950,
      tabWidth: 120,
    }), 600)
  })
})
