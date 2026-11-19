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

it('counts archive decimal labels across body and cell owners while retaining exact ordinary text', () => {
  const numbered = (value: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>${value}</w:t></w:r></w:p>`
  const raw = `<w:tbl><w:tr><w:tc>${numbered('Cell one')}</w:tc><w:tc>${numbered('Cell two')}</w:tc></w:tr></w:tbl>`
  const document = xml(raw)
    .replace(p('Before'), numbered('Before'))
    .replace(p('Tail'), numbered('Tail'))
  const numberingXml =
    '<n:numbering xmlns:n="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><n:abstractNum n:abstractNumId="9"><n:lvl n:ilvl="0"><n:start n:val="3"/><n:numFmt n:val="decimal"/><n:lvlText n:val="(%1)"/></n:lvl></n:abstractNum><n:num n:numId="7"><n:abstractNumId n:val="9"/></n:num></n:numbering>'
  expect(
    sourcePrintChains(
      document,
      [
        {
          docxIndex: 1,
          sourceTable: 'T',
          rows: [{ rowIndex: 0, cells: [source(0, 0), source(0, 1)] }],
        },
      ],
      [{ docxIndex: 1, originalXml: raw }],
      { numberingXml },
    ),
  ).toEqual({ body: '(3)Before(6)Tail', 'T:0:0': '(4)Cellone', 'T:0:1': '(5)Celltwo' })
})

it('inserts a measured legacy EQ overlay at its exact field position without weakening neighbouring source text', () => {
  const equation =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> EQ \\o</w:instrText></w:r><w:r><w:instrText>\\ac(X,Y) </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
  const document = xml('').replace(
    p('Before'),
    `<w:p><w:r><w:t>A</w:t></w:r>${equation}<w:r><w:t>Z</w:t></w:r></w:p>`,
  )
  expect(sourcePrintChains(document, [], [], { numberingXml: '' })).toEqual({ body: 'AXYZTail' })
})

const generatedNumbering = (
  level = '<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1、"/>',
  instance = '',
) =>
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0">' +
  level +
  '</w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="3"/>' +
  instance +
  '</w:num></w:numbering>'
const generatedParagraph = (text: string, id = '5', level = '0') =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`

it('retains repeated archived table identities and list occurrences while counting each original paragraph once', () => {
  const raw = `<w:tbl><w:tr><w:tc>${generatedParagraph('Same')}</w:tc></w:tr></w:tbl>`
  const models = ['First', 'Second'].map((id, index) => ({
    docxIndex: index + 1,
    sourceTable: id,
    rows: [
      { rowIndex: 0, cells: [{ sourceCell: { table: id, row: 0, cell: 0 }, gridGap: false }] },
    ],
  }))
  expect(
    sourcePrintChains(
      xml(raw + raw),
      models,
      [
        { docxIndex: 1, originalXml: raw },
        { docxIndex: 2, originalXml: raw },
      ],
      { numberingXml: generatedNumbering() },
    ),
  ).toEqual({ body: 'BeforeTail', 'First:0:0': '1、Same', 'Second:0:0': '2、Same' })
})

it('uses independent numId counters, the decimal/start defaults, and the explicit numbering removal contract', () => {
  const document = xml('').replace(
    p('Before'),
    generatedParagraph('Zero') +
      generatedParagraph('None', '0') +
      generatedParagraph('Other', '6') +
      generatedParagraph('One'),
  )
  const numberingXml = generatedNumbering('<w:lvlText w:val="[%1]"/>').replace(
    '</w:numbering>',
    '<w:num w:numId="6"><w:abstractNumId w:val="3"/></w:num></w:numbering>',
  )
  expect(sourcePrintChains(document, [], [], { numberingXml })).toEqual({
    body: '[0]ZeroNone[0]Other[1]OneTail',
  })
  expect(sourcePrintChains(xml(), tables, bindings, { numberingXml: '' })).toEqual(
    sourcePrintChains(xml(), tables, bindings),
  )
  expect(sourcePrintChains(xml(), tables, bindings, {})).toEqual(
    sourcePrintChains(xml(), tables, bindings),
  )
})

it('rejects unresolved or unsupported archive numbering rather than silently omitting labels', () => {
  const document = xml('').replace(p('Before'), generatedParagraph('Keep this source'))
  expect(() => sourcePrintChains(document, [], [], {})).toThrow('archive numbering part')
  const rejects = [
    '',
    generatedNumbering().replace('numId="5"', 'numId="6"'),
    generatedNumbering('<w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1"/>'),
    generatedNumbering('<w:start w:val="-1"/><w:lvlText w:val="%1"/>'),
    generatedNumbering('<w:lvlText w:val="%2"/>'),
    generatedNumbering(
      undefined,
      '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride>',
    ),
  ]
  for (const numberingXml of rejects)
    expect(() => sourcePrintChains(document, [], [], { numberingXml })).toThrow()
  expect(() =>
    sourcePrintChains(document.replace('w:ilvl w:val="0"', 'w:ilvl w:val="1"'), [], [], {
      numberingXml: generatedNumbering(),
    }),
  ).toThrow('Unsupported multilevel')
})

it('rejects unsupported, cached, nested and unclosed EQ fields without dropping their original text', () => {
  const field = (
    instruction: string,
    cached = '',
    ending = '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>' +
    instruction +
    '</w:instrText></w:r>' +
    cached +
    ending
  for (const equation of [
    field('EQ \\f(A,B)'),
    field('EQ \\o\\ac(A,B)', '<w:r><w:t>Original cached result</w:t></w:r>'),
    field(
      'EQ \\o\\ac(A,B)',
      '<w:r><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/></w:r>',
    ),
    field('EQ \\o\\ac(A,B)', '', ''),
  ])
    expect(() =>
      sourcePrintChains(xml('').replace(p('Before'), `<w:p>${equation}</w:p>`), [], [], {
        numberingXml: '',
      }),
    ).toThrow(/EQ/)
})

it('keeps archive source positions exact across CRLF line normalization when inserting derived text', () => {
  const document = xml('')
    .replace(p('Before'), generatedParagraph('Before'))
    .replace('<w:body>', '<w:body>\r\n')
    .replace(p('Tail'), '\r\n' + p('Tail'))
  expect(sourcePrintChains(document, [], [], { numberingXml: generatedNumbering() })).toEqual({
    body: '1、BeforeTail',
  })
})

it('finds the exact EQ ending tag after an archive CRLF declaration', () => {
  const equation =
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>EQ \\o\\ac(A,B)</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  const document = '<?xml version="1.0"?>\r\n' + xml('').replace(p('Before'), equation)
  expect(sourcePrintChains(document, [], [], { numberingXml: '' })).toEqual({ body: 'ABTail' })
})

it('rejects malformed EQ separators, instruction-after-result and unknown active markers', () => {
  const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
  const instruction = '<w:r><w:instrText>EQ \\o\\ac(A,B)</w:instrText></w:r>'
  const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  for (const content of [
    begin + instruction + separate + separate + end,
    begin + separate + instruction + end,
    begin + instruction + '<w:r><w:fldChar w:fldCharType="unknown"/></w:r>' + end,
  ])
    expect(() =>
      sourcePrintChains(xml('').replace(p('Before'), `<w:p>${content}</w:p>`), [], [], {
        numberingXml: '',
      }),
    ).toThrow('Unsupported EQ overlay')
})
