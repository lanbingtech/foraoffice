import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { setRowFills } from '../src/renderer/editor/pagination-gaps'

describe('row fill pagination feedback', () => {
  it('reports the first changed row position for additions, moves and removal', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'docParagraph', content: [{ type: 'text', text: 'unchanged prefix' }] },
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
      const rowPosition = (row: HTMLTableRowElement) => {
        const inside = editor.state.doc.resolve(editor.view.posAtDOM(row, 0))
        return inside.before(inside.depth)
      }
      const fill = { el: first, targetPx: 605.3, extraPx: 48.7 }
      expect(rowPosition(second)).toBeGreaterThan(rowPosition(first))
      expect(setRowFills(editor.view, [fill])).toBe(rowPosition(first))
      expect(setRowFills(editor.view, [fill])).toBeNull()
      expect(setRowFills(editor.view, [{ ...fill, extraPx: 48.6 }])).toBeNull()
      expect(setRowFills(editor.view, [{ ...fill, el: second }])).toBe(rowPosition(first))
      expect(setRowFills(editor.view, [])).toBe(rowPosition(second))
      expect(setRowFills(editor.view, [])).toBeNull()
    } finally {
      editor.destroy()
    }
  })
})
