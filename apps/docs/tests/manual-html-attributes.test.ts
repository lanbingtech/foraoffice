import { Editor, getAttributesFromExtensions, type AnyExtension } from '@tiptap/core'
import { DOMParser } from '@tiptap/pm/model'
import { CellSelection } from '@tiptap/pm/tables'
import { expect, it } from 'vitest'
import { editorExtensions } from '../src/renderer/editor/extensions'

const manuallyRendered = new Set([
  'docParagraph',
  'docHeading',
  'docListItem',
  'docTable',
  'docTableRow',
  'docTableCell',
  'docTableHeader',
  'docTextStyle',
])

const styledText = {
  type: 'text',
  text: 'Styled text',
  marks: [
    { type: 'docTextStyle', attrs: { color: '123456', rawRPr: '<w:rPr/>', sizeHalfPoints: 22 } },
  ],
}
const paragraph = {
  type: 'docParagraph',
  attrs: { docxIndex: 1, align: 'right', spaceAfter: 180, bidi: true, keepLines: true },
  content: [styledText],
}
const content = {
  type: 'doc',
  content: [
    paragraph,
    {
      ...paragraph,
      type: 'docHeading',
      attrs: { ...paragraph.attrs, level: 2, outlineOnly: true },
    },
    { ...paragraph, type: 'docListItem', attrs: { ...paragraph.attrs, kind: 'ordered', ilvl: 1 } },
    {
      type: 'docTable',
      attrs: { docxIndex: 2, widthPx: 240, colWidthsPct: [50, 50] },
      content: [
        {
          type: 'docTableRow',
          attrs: { repeatHeader: true },
          content: [
            {
              type: 'docTableHeader',
              attrs: { rowspan: 2, fill: 'ABCDEF', colwidth: [120] },
              content: [paragraph],
            },
            { type: 'docTableHeader', attrs: { colwidth: [120] }, content: [paragraph] },
          ],
        },
        {
          type: 'docTableRow',
          attrs: { cantSplit: true },
          content: [{ type: 'docTableCell', attrs: { colwidth: [120] }, content: [paragraph] }],
        },
      ],
    },
  ],
}

function auditRenderer(extension: AnyExtension, render: boolean, called: () => void) {
  if (!manuallyRendered.has(extension.name)) return extension
  const attributes = getAttributesFromExtensions([extension])
  return extension.extend({
    addAttributes() {
      return Object.fromEntries(
        attributes.map(({ name, attribute }) => [
          name,
          {
            ...attribute,
            ...(render ? { rendered: true } : {}),
            renderHTML(values: Record<string, unknown>) {
              called()
              return attribute.renderHTML ? attribute.renderHTML(values) : { [name]: values[name] }
            },
          },
        ]),
      )
    },
  })
}

function clipboard(editor: Editor) {
  const cells: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') cells.push(pos)
  })
  const selected = CellSelection.create(editor.state.doc, cells[0], cells.at(-1)!)
  editor.view.dispatch(editor.state.tr.setSelection(selected))
  return editor.view.serializeForClipboard(selected.content()).dom
}

it('keeps editable DOM, model, and merged-cell clipboard output without duplicate HTML attribute rendering', () => {
  let calls = 0
  let baselineCalls = 0
  const actual = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions.map((ext) => auditRenderer(ext, false, () => calls++)),
    content,
  })
  const baseline = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions.map((ext) => auditRenderer(ext, true, () => baselineCalls++)),
    content,
  })
  try {
    expect(actual.getJSON()).toEqual(baseline.getJSON())
    expect(actual.view.dom.innerHTML).toBe(baseline.view.dom.innerHTML)
    expect(actual.getHTML()).toBe(baseline.getHTML())

    const priorClipboard = clipboard(baseline)
    expect(clipboard(actual).innerHTML).toBe(priorClipboard.innerHTML)
    expect(priorClipboard.querySelector('th')?.rowSpan).toBe(2)
    expect(
      priorClipboard.querySelector('[data-doc-style]')?.getAttribute('data-doc-style'),
    ).toContain('123456')
    expect(DOMParser.fromSchema(actual.schema).parse(priorClipboard).toJSON()).toEqual(
      DOMParser.fromSchema(baseline.schema).parse(priorClipboard).toJSON(),
    )
    expect(baselineCalls).toBeGreaterThan(0)
    expect(calls).toBe(0)
  } finally {
    actual.destroy()
    baseline.destroy()
  }
})
