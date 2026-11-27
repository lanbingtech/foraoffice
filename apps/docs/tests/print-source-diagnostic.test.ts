import { expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createPrintSourceDiagnostic } from '../src/renderer/print-source-diagnostic'
import { createDocumentStoryDiagnostic } from '../src/renderer/document-story-diagnostic'

it('maps displayed merged cells to exact source cells and rejects a replaced model snapshot', async () => {
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  const bodyXml =
    '<w:tbl><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
    '<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' +
    p('Merged owner') +
    '</w:tc><w:tc>' +
    p('Top right') +
    '</w:tc></w:tr>' +
    '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>' +
    p('') +
    '</w:tc><w:tc>' +
    p('Bottom right') +
    '</w:tc></w:tr></w:tbl>'
  const parsed = await parseDocx(await buildDocx({ bodyXml }))
  const sources = createDocumentStoryDiagnostic(() => ({
    documentGeneration: 1,
    layoutGeneration: 1,
    document: { hash: 'fixture-hash', blocks: parsed.blocks },
  })).snapshot()
  expect(sources.blocks).toHaveLength(1)
  expect(sources.blocks[0]).toMatchObject({
    docxIndex: parsed.blocks[0].docxIndex,
    originalXml: bodyXml,
    textboxes: [],
  })
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  try {
    editor.commands.setContent(blocksToPmDoc(parsed.blocks) as never)
    const rowSplits = [
      { blockTop: 10, row: 1, rules: [{ from: 800, cell: 0, child: 0, clipTop: 12 }] },
    ]
    const diagnostic = createPrintSourceDiagnostic(
      editor.view,
      [{ top: 10, height: 40, docxIndex: parsed.blocks[0].docxIndex ?? undefined }],
      rowSplits,
    )
    expect(JSON.stringify({ sourceCells: diagnostic })).toBe('{}')
    const snapshot = diagnostic()
    expect(snapshot.modelCurrent).toBe(true)
    expect(snapshot.rowSplits).toEqual(rowSplits)
    expect(snapshot.tables).toHaveLength(1)
    const table = snapshot.tables[0]
    expect(table.rows[0].repeatHeader).toBe(true)
    expect(table.rows[0].cells.map((cell) => cell.sourceCell?.cell)).toEqual([0, 1])
    // Source continuation cell 0 has no displayed node. The first displayed cell is source cell 1.
    expect(table.rows[1].cells).toHaveLength(1)
    expect(table.rows[1].cells[0].sourceCell).toEqual({ table: table.sourceTable, row: 1, cell: 1 })
    expect(table.rows[1].cells[0].cellIndex).toBe(0)
    snapshot.rowSplits[0].rules[0].clipTop = 99
    expect(rowSplits[0].rules[0].clipTop).toBe(12)
    editor.commands.setContent(blocksToPmDoc(parsed.blocks) as never)
    expect(diagnostic().modelCurrent).toBe(false)
    expect(diagnostic().tables).toEqual([])
    diagnostic.dispose()
    const descriptor = Object.getOwnPropertyDescriptor(editor.view, 'state')!
    Object.defineProperty(editor.view, 'state', {
      get: () => {
        throw new Error('Retired view accessed')
      },
      configurable: true,
    })
    try {
      expect(diagnostic()).toMatchObject({ disposed: true, tables: [], blocks: [], rowSplits: [] })
    } finally {
      Object.defineProperty(editor.view, 'state', descriptor)
    }
  } finally {
    editor.destroy()
  }
})
