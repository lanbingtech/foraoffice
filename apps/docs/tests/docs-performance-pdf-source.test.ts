// @vitest-environment node
import { expect, it } from 'vitest'
import { sourcePrintChains } from '../../../e2e/docs-performance-pdf-source'

const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text: string, properties = '') =>
  `<w:tc><w:tcPr>${properties}</w:tcPr>${p(text)}</w:tc>`
const tableXml =
  '<w:tbl><w:tr>' +
  cell('Merged', '<w:vMerge w:val="restart"/>') +
  cell('Top right') +
  '</w:tr><w:tr>' +
  cell('', '<w:vMerge/>') +
  cell('Bottom right') +
  '</w:tr></w:tbl>'
const xml = (table = tableXml) =>
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body>' +
  p('Before') +
  table +
  p('Tail') +
  '</w:body></w:document>'
const source = (row: number, cell: number) => ({
  sourceCell: { table: 'T', row, cell },
  gridGap: false,
})
const tables = [
  {
    docxIndex: 1,
    sourceTable: 'T',
    rows: [
      { rowIndex: 0, cells: [source(0, 0), source(0, 1)] },
      { rowIndex: 1, cells: [source(1, 1)] },
    ],
  },
]
const bindings = [{ docxIndex: 1, originalXml: tableXml }]

it('derives cell and non-table body chains from independent archive XML using displayed source-cell identity', () => {
  expect(sourcePrintChains(xml(), tables, bindings)).toEqual({
    body: 'BeforeTail',
    'T:0:0': 'Merged',
    'T:0:1': 'Topright',
    'T:1:1': 'Bottomright',
  })
})

it('rejects missing source cells, invented source XML, grid gaps and a nonempty hidden merge continuation', () => {
  const missing = structuredClone(tables)
  missing[0].rows[1].cells = []
  expect(() => sourcePrintChains(xml(), missing, bindings)).toThrow('Unmapped source cell')
  expect(() =>
    sourcePrintChains(xml(), tables, [
      { ...bindings[0], originalXml: tableXml.replace('Merged', 'Invented') },
    ]),
  ).toThrow('Printed table source XML is not archived')
  const gap = structuredClone(tables)
  gap[0].rows[0].cells[0].gridGap = true
  expect(() => sourcePrintChains(xml(), gap, bindings)).toThrow(
    'Unsupported grid-gap source mapping',
  )
  const changed = tableXml.replace(cell('', '<w:vMerge/>'), cell('Hidden text', '<w:vMerge/>'))
  expect(() =>
    sourcePrintChains(xml(changed), tables, [{ ...bindings[0], originalXml: changed }]),
  ).toThrow('Nonempty hidden source cell')
  expect(() => sourcePrintChains(xml(tableXml + tableXml), tables, bindings)).toThrow(
    'Source table coverage differs',
  )
})
