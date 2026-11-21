import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { setRowFills } from '../src/renderer/editor/pagination-gaps'

describe('row fill pagination feedback', () => {
  it('reports applied geometry changes without requesting new passes for subpixel compensation jitter', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docTable',
            content: ['first row', 'second row'].map((text) => ({
              type: 'docTableRow',
              content: [
                {
                  type: 'docTableCell',
                  content: [{ type: 'docParagraph', content: [{ type: 'text', text }] }],
                },
              ],
            })),
          },
        ],
      },
    })
    try {
      const [first, second] = Array.from(editor.view.dom.querySelectorAll('tr'))
      const fill = { el: first, targetPx: 605.3, extraPx: 48.7 }
      expect(setRowFills(editor.view, [fill])).toBe(true)
      expect(setRowFills(editor.view, [fill])).toBe(false)
      expect(setRowFills(editor.view, [{ ...fill, extraPx: 48.6 }])).toBe(false)
      expect(setRowFills(editor.view, [{ ...fill, el: second }])).toBe(true)
      expect(setRowFills(editor.view, [])).toBe(true)
      expect(setRowFills(editor.view, [])).toBe(false)
    } finally {
      editor.destroy()
    }
  })
})
