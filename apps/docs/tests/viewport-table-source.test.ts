import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  collectViewportTableFragments,
  rebaseViewportTableFragments,
} from '../src/renderer/editor/viewport-table-source'
import { computeSectionedSlicesF2 } from '../src/renderer/pagination-slices'
import type { BlockBox, RowCellBox, SliceOutputs } from '../src/renderer/pagination-types'

const schema = new Schema({
  nodes: {
    doc: { content: '(docTable | paragraph)+' },
    docTable: { content: 'docTableRow+' },
    docTableRow: { content: 'docTableCell+' },
    docTableCell: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: { inline: true },
  },
})

function fixture() {
  const model = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'docTable',
        content: [
          {
            type: 'docTableRow',
            content: ['First cell contains five lines', 'Second cell has one line'].map((text) => ({
              type: 'docTableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            })),
          },
        ],
      },
    ],
  })
  const linesOf = (count: number): RowCellBox => ({
    lines: Array.from({ length: count }, (_, i) => [i * 20, (i + 1) * 20]),
    childOf: Array.from({ length: count }, (_, i) => i),
    paraOf: Array.from({ length: count }, (_, i) => i),
    alignDy: 0,
    alignFrac: 0,
  })
  const block: BlockBox = {
    top: 0,
    height: 100,
    tableRows: [{ height: 100, forcedCuts: [60], cells: [linesOf(5), linesOf(1)] }],
  }
  const outputs: SliceOutputs = { rowSplits: [] }
  const slices = computeSectionedSlicesF2(
    [block],
    [{ contentHeight: 200, forceBreak: false, cols: 2 }],
    100,
    outputs,
  )
  return { model, block, slices, patches: outputs.rowSplits! }
}

describe('table row source fragments', () => {
  it('preserves authored cell intervals on their actual columns', () => {
    const { model, block, slices, patches } = fixture()
    const row = model.firstChild!.firstChild!
    const secondStart = 3 + row.firstChild!.nodeSize
    const firstEnd = 3 + row.firstChild!.content.size
    const secondEnd = secondStart + row.lastChild!.content.size
    expect(
      collectViewportTableFragments(model, [block], slices, patches, {
        read: (_block, _row, cell, lines) =>
          lines.map(
            (line) => (cell === 0 ? [3, 8, 12, 16, 20, firstEnd] : [secondStart, secondEnd])[line],
          ),
      }),
    ).toEqual([
      {
        cutIndex: 0,
        regionIndex: 0,
        columnIndex: 0,
        tablePosition: 0,
        rowIndex: 0,
        from: 0,
        to: 60,
        cells: [
          { from: 3, to: 16 },
          { from: secondStart, to: secondEnd },
        ],
      },
      {
        cutIndex: 0,
        regionIndex: 0,
        columnIndex: 1,
        tablePosition: 0,
        rowIndex: 0,
        from: 60,
        to: 100,
        cells: [
          { from: 16, to: firstEnd },
          { from: secondEnd, to: secondEnd },
        ],
      },
    ])
  })

  it('omits the entire row when a cell boundary is unresolved', () => {
    const { model, block, slices, patches } = fixture()
    expect(
      collectViewportTableFragments(model, [block], slices, patches, {
        read: (_block, _row, cell, lines) =>
          cell === 0 ? lines.map((line) => line + 4) : undefined,
      }),
    ).toEqual([])
  })

  it('carries unchanged tables across edits to earlier paragraphs', () => {
    const { model } = fixture()
    const paragraph = schema.node('paragraph', undefined, schema.text('A paragraph'))
    const source = schema.node('doc', undefined, [paragraph, model.firstChild!])
    const start = paragraph.nodeSize
    const fragment = {
      cutIndex: 1,
      tablePosition: start,
      rowIndex: 0,
      from: 100,
      to: 140,
      cells: [{ from: start + 16, to: start + 20 }],
    }
    const state = EditorState.create({ doc: source })
    const editedAbove = state.tr.insertText('new', 3).doc
    const editedInside = state.tr.insertText('new', start + 6).doc
    expect(rebaseViewportTableFragments(source, editedAbove, [fragment])).toEqual([
      {
        ...fragment,
        tablePosition: start + 3,
        cells: [{ from: start + 19, to: start + 23 }],
      },
    ])
    expect(rebaseViewportTableFragments(source, editedInside, [fragment])).toBeUndefined()
  })
})
