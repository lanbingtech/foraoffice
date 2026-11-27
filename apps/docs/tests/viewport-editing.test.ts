import { Schema } from '@tiptap/pm/model'
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  createViewportEditing,
  projectViewportFollowUps,
  projectViewportTransaction,
} from '../src/renderer/editor/viewport-editing'

const schema = new Schema({
  nodes: {
    doc: { content: '(docParagraph | docTable)+' },
    docTable: { content: 'docTableRow+' },
    docTableRow: { content: 'docTableCell+' },
    docTableCell: { content: 'docParagraph+', attrs: { rowspan: { default: 1 } } },
    docParagraph: { content: 'inline*' },
    docInlineImage: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: {
        name: {},
        width: { default: 100 },
        wrap: { default: null },
        rule: { default: false },
      },
    },
    text: { group: 'inline' },
  },
})

const paragraph = (text: string) => schema.nodes.docParagraph.create(null, schema.text(text))

function textViewport() {
  const source = schema.node('doc', null, [
    paragraph('abc'),
    paragraph('abc'),
    paragraph('DEF'),
    paragraph('xyz'),
  ])
  const viewport = createViewportEditing(source, [
    { from: 5, to: 10 },
    { from: 10, to: 15 },
  ])!
  return {
    source,
    viewport,
    local: EditorState.create({ doc: viewport.doc }),
    authoritative: EditorState.create({ doc: source }),
  }
}

function pictureDocument() {
  const pictures = ['first', 'second', 'third', 'fourth'].map((name) =>
    schema.nodes.docInlineImage.create({ name }),
  )
  const source = schema.node('doc', null, [
    paragraph('abc'),
    schema.nodes.docParagraph.create(null, pictures),
    paragraph('xyz'),
  ])
  return { source, pictures }
}

describe('editable document viewport', () => {
  it('maps a merged-cell text continuation without changing its table siblings', () => {
    const cell = schema.node('docTableCell', { rowspan: 2 }, [
      paragraph('before middle after'),
      paragraph('next in the same cell'),
    ])
    const neighbour = schema.node('docTableCell', null, paragraph('neighbour'))
    const table = schema.node('docTable', null, [
      schema.node('docTableRow', null, [cell, neighbour]),
      schema.node('docTableRow', null, neighbour),
    ])
    const source = schema.node('doc', null, [paragraph('lead'), table])
    const tableFrom = source.firstChild!.nodeSize
    const position = tableFrom + 3
    const from = position + 1 + 'before '.length
    const blocks = [
      {
        from: tableFrom,
        to: tableFrom + table.nodeSize,
        tableCellText: { position, from, to: from + 'middle'.length },
      },
    ]
    const viewport = createViewportEditing(source, blocks)!
    expect(viewport.doc.textContent).toBe('middle')
    expect(viewport.toSource(1)).toBe(from)
    expect(viewport.toLocal(from - 1)).toBeUndefined()

    const local = EditorState.create({ doc: viewport.doc })
    const authoritative = EditorState.create({ doc: source })
    const edit = local.tr.insertText('!', 7)
    edit.setSelection(TextSelection.create(edit.doc, 8))
    const projected = projectViewportTransaction(viewport, authoritative, edit)!
    const row = projected.doc.lastChild!.firstChild!
    expect(projected.selection.from).toBe(from + 7)
    expect(row.firstChild!.attrs.rowspan).toBe(2)
    expect(row.firstChild!.firstChild!.textContent).toBe('before middle! after')
    expect(row.firstChild!.lastChild).toBe(cell.lastChild)
    expect(row.lastChild).toBe(neighbour)
    expect(projectViewportTransaction(viewport, authoritative, local.tr.split(4))).toBeUndefined()

    const accepted = authoritative.apply(projected)
    const followUp = accepted.tr.insertText('?', from + 7)
    expect(projectViewportFollowUps(viewport, local, edit, [followUp])?.doc.textContent).toBe(
      'middle!?',
    )
    expect(createViewportEditing(source, [{ ...blocks[0], from: 0 }])).toBeUndefined()
    expect(
      createViewportEditing(source, [
        { ...blocks[0], tableCellText: { position, from, to: from + cell.nodeSize } },
      ]),
    ).toBeUndefined()
  })

  it('maps an interior paragraph continuation to its original text and preserves offscreen text', () => {
    const source = schema.node('doc', null, [paragraph('before middle after')])
    const viewport = createViewportEditing(source, [
      { from: 0, to: source.content.size, paragraph: { from: 8, to: 14 } },
    ])!
    expect(viewport.doc.textContent).toBe('middle')
    expect(viewport.toSource(1)).toBe(8)
    expect(viewport.toLocal(14)).toBe(7)
    expect(viewport.toLocal(15)).toBeUndefined()

    const local = EditorState.create({ doc: viewport.doc })
    const authoritative = EditorState.create({ doc: source })
    const transaction = projectViewportTransaction(
      viewport,
      authoritative,
      local.tr.insertText('!', 7),
    )
    expect(transaction?.doc.textContent).toBe('before middle! after')
    expect(projectViewportTransaction(viewport, authoritative, local.tr.split(4))).toBeUndefined()
  })

  it('translates multiple text steps and a backward selection while retaining offscreen blocks', () => {
    const { source, viewport, local, authoritative } = textViewport()
    expect(viewport.doc.textContent).toBe('abcDEF')
    expect(viewport.toSource(0)).toBe(5)
    expect(viewport.toSource(10)).toBe(15)
    expect(viewport.toLocal(4)).toBeUndefined()

    const edit = local.tr.insertText('中', 2).insertText('!', 8).setTime(123)
    edit.setSelection(TextSelection.create(edit.doc, 10, 3))
    const projected = projectViewportTransaction(viewport, authoritative, edit)!
    const next = authoritative.apply(projected)

    expect(projected.time).toBe(123)
    expect(next.doc.textContent).toBe('abca中bcD!EFxyz')
    expect(next.doc.firstChild).toBe(source.firstChild)
    expect(next.doc.lastChild).toBe(source.lastChild)
    expect([next.selection.anchor, next.selection.head]).toEqual([15, 8])
  })

  it('allows an interior split but rejects structural operations at the cropped root edges', () => {
    const { viewport, local, authoritative } = textViewport()
    const split = projectViewportTransaction(viewport, authoritative, local.tr.split(2))!
    expect(split.doc.childCount).toBe(5)
    expect(split.doc.child(1).textContent).toBe('a')
    expect(split.doc.child(2).textContent).toBe('bc')

    expect(
      projectViewportTransaction(viewport, authoritative, local.tr.delete(0, 5)),
    ).toBeUndefined()
    expect(
      projectViewportTransaction(viewport, authoritative, local.tr.delete(5, 10)),
    ).toBeUndefined()
    expect(
      projectViewportTransaction(
        viewport,
        authoritative,
        local.tr.setSelection(new AllSelection(local.doc)),
      ),
    ).toBeUndefined()
  })

  it('preserves only supported native input metadata on a projected edit', () => {
    const { viewport, local, authoritative } = textViewport()
    const edit = local.tr
      .insertText('文', 2)
      .setMeta('composition', 17)
      .setMeta('uiEvent', 'paste')
      .setMeta('pointer', true)
      .setMeta('application-private', { blocked: true })
    const projected = projectViewportTransaction(viewport, authoritative, edit)!
    expect(projected.getMeta('composition')).toBe(17)
    expect(projected.getMeta('uiEvent')).toBe('paste')
    expect(projected.getMeta('pointer')).toBe(true)
    expect(projected.getMeta('application-private')).toBeUndefined()
  })

  it('maps only the real picture positions and resizes a visible picture by identity', () => {
    const { source, pictures } = pictureDocument()
    const viewport = createViewportEditing(source, [
      {
        from: 5,
        to: 11,
        pictures: [
          { from: 7, to: 8 },
          { from: 8, to: 9 },
        ],
      },
    ])!
    expect(viewport.doc.firstChild?.childCount).toBe(2)
    expect(viewport.doc.firstChild?.firstChild).toBe(pictures[1])
    expect(viewport.toSource(0)).toBeUndefined()
    expect(viewport.toSource(1)).toBe(7)
    expect(viewport.toSource(3)).toBe(9)
    expect(viewport.toSource(4)).toBeUndefined()
    expect(viewport.toLocal(6)).toBeUndefined()
    expect(viewport.toLocal(8)).toBe(2)
    expect(viewport.toLocal(10)).toBeUndefined()

    const local = EditorState.create({ doc: viewport.doc })
    const authoritative = EditorState.create({ doc: source })
    const edit = local.tr.setNodeAttribute(1, 'width', 250)
    edit.setSelection(NodeSelection.create(edit.doc, 1))
    const projected = projectViewportTransaction(viewport, authoritative, edit)!
    const result = projected.doc.child(1)
    expect(projected.selection).toBeInstanceOf(NodeSelection)
    expect(projected.selection.anchor).toBe(7)
    expect(result.child(0)).toBe(pictures[0])
    expect(result.child(1).attrs).toMatchObject({ name: 'second', width: 250 })
    expect(result.child(2)).toBe(pictures[2])
    expect(result.child(3)).toBe(pictures[3])
    expect(projectViewportTransaction(viewport, authoritative, local.tr.split(2))).toBeUndefined()
  })

  it('keeps adjacent whole blocks editable beside a cropped picture paragraph', () => {
    const { source } = pictureDocument()
    const viewport = createViewportEditing(source, [
      {
        from: 5,
        to: 11,
        pictures: [
          { from: 8, to: 9 },
          { from: 9, to: 10 },
        ],
      },
      { from: 11, to: 16 },
    ])!
    expect(viewport.toSource(4)).toBe(11)
    const local = EditorState.create({ doc: viewport.doc })
    const authoritative = EditorState.create({ doc: source })
    const projected = projectViewportTransaction(
      viewport,
      authoritative,
      local.tr.insertText('!', 6),
    )!
    expect(projected.doc.lastChild?.textContent).toBe('x!yz')
    expect(projected.doc.child(1)).toBe(source.child(1))
  })

  it('refuses block holes, omitted interior pictures, and an unavailable picture fragment', () => {
    const { source } = pictureDocument()
    expect(
      createViewportEditing(source, [
        { from: 0, to: 5 },
        { from: 11, to: 16 },
      ]),
    ).toBeUndefined()
    expect(
      createViewportEditing(source, [
        { from: 0, to: 5 },
        { from: 5, to: 11, pictures: [{ from: 7, to: 8 }] },
        { from: 11, to: 16 },
      ]),
    ).toBeUndefined()
    expect(
      createViewportEditing(source, [
        {
          from: 5,
          to: 11,
          pictures: [
            { from: 6, to: 7 },
            { from: 8, to: 9 },
          ],
        },
      ]),
    ).toBeUndefined()
    expect(createViewportEditing(source, [{ from: 5, to: 11, pictures: [] }])).toBeUndefined()
  })

  it('rejects a stale revision even when its replacement has identical content', () => {
    const { source, viewport, local, authoritative } = textViewport()
    const newer = EditorState.create({ doc: schema.nodeFromJSON(source.toJSON()) })
    expect(newer.doc.eq(source)).toBe(true)
    expect(projectViewportTransaction(viewport, newer, local.tr.insertText('!', 2))).toBeUndefined()
    const staleLocal = EditorState.create({ doc: schema.nodeFromJSON(viewport.doc.toJSON()) })
    expect(
      projectViewportTransaction(viewport, authoritative, staleLocal.tr.insertText('!', 2)),
    ).toBeUndefined()
  })
})
