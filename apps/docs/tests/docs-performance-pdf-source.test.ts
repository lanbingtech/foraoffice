// @vitest-environment node
import { expect, it } from 'vitest'
import {
  projectPrintedTextboxes,
  sourcePrintChains,
  sourceHeaderFooterChains,
} from '../../../e2e/docs-performance-pdf-source'

it('projects only source textbox characters measured beyond their own clip in every copy', () => {
  const source = { 'box:1:0': 'A💠B', 'box:2:0': 'Untouched', body: 'Body' }
  const first = { owner: 'box:1:0', page: 0, text: 'A💠B', clipped: [1, 2] }
  const next = { owner: 'box:1:0', page: 1, text: 'A💠B', clipped: [2] }
  expect(projectPrintedTextboxes(source, [first, next])).toEqual({
    chains: { ...source, 'box:1:0': 'A💠' },
    clippedTextboxes: { 'box:1:0': [2] },
  })
  expect(() => projectPrintedTextboxes(source, [{ ...first, text: 'A.B' }])).toThrow(
    'exact archived story',
  )
  expect(() => projectPrintedTextboxes(source, [{ ...first, clipped: [3] }])).toThrow(
    'clip index is invalid',
  )
})

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

it('rejects missing source cells, invented source XML, invented grid gaps and a nonempty hidden merge continuation', () => {
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

it('maps authored leading/trailing grid gaps as one model slot each and never aliases their real first cell', () => {
  const raw =
    '<w:tbl><w:tr><w:trPr><w:gridBefore w:val="2"/><w:gridAfter w:val="1"/></w:trPr>' +
    cell('Real first') +
    cell('Real second') +
    '</w:tr></w:tbl>'
  const model = [
    {
      docxIndex: 1,
      sourceTable: 'T',
      rows: [
        {
          rowIndex: 0,
          cells: [
            { ...source(0, 0), gridGap: true, colspan: 2 },
            source(0, 1),
            source(0, 2),
            { ...source(0, 3), gridGap: true, colspan: 1 },
          ],
        },
      ],
    },
  ]
  const archive = [{ docxIndex: 1, originalXml: raw }]
  expect(sourcePrintChains(xml(raw), model, archive)).toEqual({
    body: 'BeforeTail',
    'T:0:1': 'Realfirst',
    'T:0:2': 'Realsecond',
  })
  const aliased = structuredClone(model)
  aliased[0].rows[0].cells[1].sourceCell.cell = 0
  expect(() => sourcePrintChains(xml(raw), aliased, archive)).toThrow('Source cell address')
  const absent = structuredClone(model)
  absent[0].rows[0].cells.shift()
  expect(() => sourcePrintChains(xml(raw), absent, archive)).toThrow('Authored grid edge')
})

it('keeps an empty uncovered merge-continuation gap distinct from an authored edge gap', () => {
  const model = structuredClone(tables)
  model[0].rows[1].cells.unshift({ ...source(1, 0), gridGap: true })
  expect(sourcePrintChains(xml(), model, bindings)).toEqual({
    body: 'BeforeTail',
    'T:0:0': 'Merged',
    'T:0:1': 'Topright',
    'T:1:1': 'Bottomright',
  })
})

it('accepts identical ordinary table XML without inventing textbox source bindings', () => {
  const raw = '<w:tbl><w:tr>' + cell('Duplicate ordinary table') + '</w:tr></w:tbl>'
  const model = ['T', 'U'].map((table, index) => ({
    docxIndex: index + 1,
    sourceTable: table,
    rows: [{ rowIndex: 0, cells: [{ gridGap: false, sourceCell: { table, row: 0, cell: 0 } }] }],
  }))
  expect(
    sourcePrintChains(
      xml(raw + raw),
      model,
      model.map((table) => ({
        docxIndex: table.docxIndex,
        originalXml: raw,
        textboxes: [],
      })),
    ),
  ).toEqual({
    body: 'BeforeTail',
    'T:0:0': 'Duplicateordinarytable',
    'U:0:0': 'Duplicateordinarytable',
  })
})

it('derives default inherited header/footer stories and decimal PAGE from raw section/relationship XML', () => {
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const partNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const field =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText> PAGE \\* MERGEFORMAT </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>999</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
  const first = `<w:sectPr><w:headerReference w:type="default" r:id="H"/><w:footerReference w:type="default" r:id="F"/><w:pgNumType w:start="5"/></w:sectPr>`
  const document = xml('')
    .replace('<w:document ', `<w:document xmlns:r="${relNs}" `)
    .replace(p('Before'), `<w:p><w:pPr>${first}</w:pPr></w:p>`)
    .replace('</w:body>', '<w:sectPr><w:pgNumType w:start="103"/></w:sectPr></w:body>')
  const relationships = `<Relationships xmlns="${partNs}"><Relationship Id="H" Type="${relNs}/header" Target="header1.xml"/><Relationship Id="F" Type="${relNs}/footer" Target="footer1.xml"/></Relationships>`
  const header = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page </w:t></w:r>${field}</w:p></w:hdr>`
  const parts = {
    'word/header1.xml': header,
    'word/footer1.xml': `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${p('Literal footer')}</w:ftr>`,
  }
  expect(sourceHeaderFooterChains(document, '', relationships, parts, [0, 0, 1])).toEqual({
    'hf:0:header': 'Page5',
    'hf:0:footer': 'Literalfooter',
    'hf:1:header': 'Page6',
    'hf:1:footer': 'Literalfooter',
    'hf:2:header': 'Page103',
    'hf:2:footer': 'Literalfooter',
  })
  expect(() =>
    sourceHeaderFooterChains(
      document,
      '',
      relationships.replace('/header"', '/footer"'),
      parts,
      [0],
    ),
  ).toThrow('Header/footer relationship')
  expect(() =>
    sourceHeaderFooterChains(
      document,
      '',
      relationships,
      { ...parts, 'word/header1.xml': header.replace(' PAGE ', ' NUMPAGES ') },
      [0],
    ),
  ).toThrow('Unsupported header/footer field')
})

it('requires equivalent alternate HF stories and rejects unsupported fields, external parts and missing source text', () => {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const doc = `<w:document xmlns:w="${w}" xmlns:r="${rel}"><w:body><w:sectPr><w:headerReference w:type="default" r:id="H"/></w:sectPr></w:body></w:document>`
  const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="H" Type="${rel}/header" Target="header1.xml"/></Relationships>`
  const value =
    p('Page') + '<w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>999</w:t></w:r></w:fldSimple></w:p>'
  const header = `<w:hdr xmlns:w="${w}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:AlternateContent><mc:Choice Requires="x">${value}</mc:Choice><mc:Fallback>${value}</mc:Fallback></mc:AlternateContent></w:hdr>`
  const parts = { 'word/header1.xml': header }
  expect(sourceHeaderFooterChains(doc, '', relationships, parts, [0])).toEqual({
    'hf:0:header': 'Page1',
  })
  expect(() =>
    sourceHeaderFooterChains(
      doc,
      '',
      relationships,
      {
        'word/header1.xml': header.replace(`<mc:Fallback>${value}</mc:Fallback>`, ''),
      },
      [0],
    ),
  ).toThrow('alternate text requires a consumer profile')
  expect(() =>
    sourceHeaderFooterChains(
      doc,
      '',
      relationships,
      {
        'word/header1.xml': header.replace('<mc:Fallback>', '<mc:Fallback>' + p('Lost variant')),
      },
      [0],
    ),
  ).toThrow('alternate text requires a consumer profile')
  expect(() =>
    sourceHeaderFooterChains(
      doc,
      '',
      relationships,
      {
        'word/header1.xml': header.replaceAll('w:instr="PAGE"', 'w:instr="NUMPAGES"'),
      },
      [0],
    ),
  ).toThrow('Unsupported header/footer field instruction')
  expect(() =>
    sourceHeaderFooterChains(
      doc,
      '',
      relationships.replace(' Target=', ' TargetMode="External" Target='),
      parts,
      [0],
    ),
  ).toThrow('wrong type/mode')
  expect(() => sourceHeaderFooterChains(doc, '', relationships, {}, [0])).toThrow(
    'target is missing',
  )
})
