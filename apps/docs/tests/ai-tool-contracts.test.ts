import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { serializeRangeToHtml, buildDocumentContext } from '../src/renderer/ai/protocol'
import { executeOps } from '../src/renderer/ai/ops'
import { imageBlockSource, executeTool } from '../src/renderer/ai/tools'
const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})
const para = (text: string) => ({ type: 'docParagraph', content: [{ type: 'text', text }] })
const image = (src: string) => ({ type: 'docInlineImage', attrs: { dataUrl: src } })
function editor(content: PmNode[]) {
  const e = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  editors.push(e)
  return e
}
it('reads the same inline image ordinal in paragraphs and tables that read_blocks exposes', () => {
  const e = editor([
    {
      type: 'docParagraph',
      content: [image('data:image/png;base64,QQ=='), image('data:image/png;base64,Qg==')],
    },
    {
      type: 'docTable',
      content: [
        {
          type: 'docTableRow',
          content: [
            {
              type: 'docTableCell',
              content: [{ type: 'docParagraph', content: [image('data:image/png;base64,Qw==')] }],
            },
          ],
        },
      ],
    },
  ])
  expect(serializeRangeToHtml(e, 0, 1)).toContain('doc:0.1')
  expect(imageBlockSource(e, 0, 1)?.src).toBe('data:image/png;base64,Qg==')
  expect(imageBlockSource(e, 1, 0)?.src).toBe('data:image/png;base64,Qw==')
  expect(imageBlockSource(e, 0, 3)).toBeNull()
  expect(imageBlockSource(e, 0)).toBeNull()
})
it('reports colspan and rowspan without implying merged HTML can be flattened on rewrite', () => {
  const e = editor([
    {
      type: 'docTable',
      content: [
        {
          type: 'docTableRow',
          content: [
            { type: 'docTableCell', attrs: { colspan: 2, rowspan: 2 }, content: [para('MERGED')] },
            { type: 'docTableCell', content: [para('A')] },
          ],
        },
        { type: 'docTableRow', content: [{ type: 'docTableCell', content: [para('B')] }] },
      ],
    },
  ])
  const html = serializeRangeToHtml(e, 0, 0)
  expect(html).toContain('colspan="2" rowspan="2"')
  expect(html).toContain('data-doc-readonly="merged-table"')
  expect(html.match(/MERGED/g)?.length).toBe(1)
})
it('rejects table-to-list targets clearly and atomically', () => {
  const e = editor([
    para('BEFORE'),
    {
      type: 'docTable',
      content: [
        { type: 'docTableRow', content: [{ type: 'docTableCell', content: [para('CELL')] }] },
      ],
    },
  ])
  const before = e.getJSON()
  const result = executeOps(e, [
    { op: 'findReplace', find: 'BEFORE', replace: 'WRONG' },
    { op: 'setList', target: { blockIndexes: [1] }, kind: 'number' },
  ])
  expect(result.ok).toBe(false)
  expect(result.error).toContain('not a paragraph or list item')
  expect(e.getJSON()).toEqual(before)
})
it('passes an explicitly selected header/footer section and describes default section accurately', async () => {
  const e = editor([para('BODY')])
  const writes: unknown[] = []
  const state = {
    header: '',
    footer: '',
    headerFirst: null,
    footerFirst: null,
    headerEven: null,
    footerEven: null,
    titlePg: false,
    evenOddHf: false,
    multiSection: true,
    sections: [
      { index: 0, variants: [] },
      { index: 1, variants: [] },
    ],
  }
  const access = {
    read: () => state,
    set: (...args: unknown[]) => {
      writes.push(args)
      return null
    },
  }
  const result = await executeTool(
    e,
    { id: 'x', name: 'set_header_footer', input: { kind: 'footer', text: 'TEST', section: 1 } },
    { bullet: null, ordered: null },
    undefined,
    undefined,
    undefined,
    undefined,
    access,
  )
  expect(result.isError).toBeFalsy()
  expect(writes).toEqual([['footer', 'default', 'TEST', 1]])
  expect(buildDocumentContext(e, undefined, access.read())).not.toContain(
    'edits apply to the first section',
  )
})
