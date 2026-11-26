import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createTableCellBoundaryLookup,
  fillLineBoxes,
  type BlockBox,
} from '../src/renderer/pagination'

const schema = new Schema({
  nodes: {
    doc: { content: 'docTable+' },
    docTable: { content: 'docTableRow+', toDOM: () => ['table', ['tbody', 0]] },
    docTableRow: { content: 'docTableCell+', toDOM: () => ['tr', 0] },
    docTableCell: { content: '(docParagraph | docNestedTable)+', toDOM: () => ['td', 0] },
    docParagraph: { content: 'text*', toDOM: () => ['p', 0] },
    docNestedTable: {
      atom: true,
      toDOM: () => ['div', { class: 'doc-nested-table' }, ['p', 'nested']],
    },
    text: {},
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
})

const para = (text: string) =>
  schema.node('docParagraph', null, text ? schema.text(text) : undefined)
const cell = (...content: ReturnType<typeof para>[]) => schema.node('docTableCell', null, content)
const row = (...cells: ReturnType<typeof cell>[]) => schema.node('docTableRow', null, cells)
const geoms = [{ contentHeight: 50, forceBreak: false }]
const views: EditorView[] = []
const originalClientRects = Range.prototype.getClientRects

afterEach(() => {
  for (const view of views.splice(0)) {
    const mount = view.dom.parentElement
    view.destroy()
    mount?.remove()
  }
  Range.prototype.getClientRects = originalClientRects
  vi.restoreAllMocks()
})

function measuredTable(nested = false) {
  const wrapped = schema.node('docParagraph', null, [
    schema.text('ABcd'),
    schema.text('efGH', [schema.mark('strong')]),
  ])
  const firstCell = cell(wrapped, nested ? schema.node('docNestedTable') : para('Tail'))
  const table = schema.node('docTable', null, [
    row(firstCell, cell(para('Other'))),
    row(cell(para('Second')), cell(para(''))),
  ])
  const doc = schema.node('doc', null, table)
  const view = new EditorView(document.body.appendChild(document.createElement('div')), {
    state: EditorState.create({ doc }),
  })
  views.push(view)
  const element = view.nodeDOM(0) as HTMLElement
  const block: BlockBox = { top: 0, height: 200, el: element }
  const bodies = [...element.querySelectorAll('tr')]
  const standalone = [...element.querySelectorAll('p')]
  const textTops: Record<string, number[]> = {
    ABcd: [3, 3, 23, 23],
    efGH: [20, 20, 40, 40],
    Tail: [60, 60, 60, 60],
    nested: [60, 60, 60, 60, 60, 60],
    Other: [0, 0, 0, 0, 0],
    Second: [100, 100, 100, 100, 100, 100],
  }
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 200))
  bodies.forEach((tr, index) =>
    vi.spyOn(tr, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 100, 100, 100)),
  )
  standalone.forEach((p) =>
    vi
      .spyOn(p, 'getBoundingClientRect')
      .mockReturnValue(
        new DOMRect(
          0,
          p === standalone[0] ? 0 : (textTops[p.textContent ?? '']?.[0] ?? 100),
          50,
          15,
        ),
      ),
  )
  const readNodes: string[] = []
  const readRects = vi.fn(function (this: Range) {
    const text = this.startContainer.textContent ?? ''
    readNodes.push(text)
    const tops = textTops[text] ?? []
    return [...new Set(tops.slice(this.startOffset, this.endOffset))].map(
      (top) => new DOMRect(0, top, 30, 14),
    ) as unknown as DOMRectList
  })
  Range.prototype.getClientRects = readRects
  return {
    view,
    block,
    readRects,
    readNodes,
    textTops,
    paragraphEnd: 3 + wrapped.nodeSize,
    cellEnd: 3 + firstCell.content.size,
  }
}

it('resolves only requested source cuts, including the earliest authored run on a shared line', () => {
  const { view, block, readRects, readNodes, paragraphEnd, cellEnd } = measuredTable()
  const lookup = createTableCellBoundaryLookup(view, 1)
  expect(fillLineBoxes([block], geoms, 1, undefined, undefined, undefined, lookup)).toBe(true)
  expect(block.tableRows?.[0].cells?.[0].lines).toHaveLength(4)
  readNodes.length = 0
  expect(lookup.read(block, 0, 0, [0, 4])).toEqual([3, cellEnd])
  expect(readNodes).toEqual([])
  // Text starts at PM 4. Line 1 begins at c, although strong ef has higher ink.
  expect(lookup.read(block, 0, 0, [0, 1, 2, 3, 4])).toEqual([3, 6, 10, paragraphEnd, cellEnd])
  expect([...new Set(readNodes)]).toEqual(['ABcd', 'efGH'])
  const reads = readRects.mock.calls.length
  expect(lookup.read(block, 0, 0, [2, 2])).toEqual([10, 10])
  expect(readRects).toHaveBeenCalledTimes(reads)
})

it('resamples only a requested row carried without source anchors and rejects differing geometry', () => {
  const { view, block, readNodes, textTops } = measuredTable()
  fillLineBoxes([block], geoms, 1)
  readNodes.length = 0
  const lookup = createTableCellBoundaryLookup(view, 1)
  expect(lookup.read(block, 0, 0, [1])).toEqual([6])
  expect(readNodes).not.toContain('Second')
  textTops.efGH[2] = textTops.efGH[3] = 46
  expect(createTableCellBoundaryLookup(view, 1).read(block, 0, 0, [2])).toBeUndefined()
})

it('rejects an opaque nested table instead of mapping its measured lines to one outer position', () => {
  const { view, block } = measuredTable(true)
  const lookup = createTableCellBoundaryLookup(view, 1)
  fillLineBoxes([block], geoms, 1, undefined, undefined, undefined, lookup)
  expect(lookup.read(block, 0, 0, [3])).toBeUndefined()
})
