import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

export const PERFORMANCE_END = 'PERFORMANCE DOCUMENT END'

/** Public, deterministic structural sample; it contains no private document text. */
export async function buildPerformanceFixture(scale = 1): Promise<Uint8Array> {
  if (!Number.isInteger(scale) || scale < 1 || scale > 10) throw new Error('Invalid fixture scale')
  const wmf = await readFile(
    resolve(__dirname, '../packages/docx-engine/tests/fixtures/mathtype-axb.wmf'),
  )
  const body: string[] = []
  const sections = [
    '<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr>',
    '<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1080" w:bottom="1080" w:left="720" w:right="2160"/></w:sectPr>',
    '<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/><w:pgMar w:top="1800" w:bottom="1080" w:left="1800" w:right="1080"/></w:sectPr>',
  ]
  const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
  for (let group = 0; group < 17 * scale; group++) {
    for (let p = 0; p < 13; p++)
      body.push(
        paragraph(
          `Body ${group}-${p}: A reproducible document paragraph. 中文排版，标点压缩与换行。`.repeat(
            2,
          ),
        ),
      )
    body.push(
      '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr>' +
        '<w:tblGrid>' +
        '<w:gridCol w:w="1800"/>'.repeat(5) +
        '</w:tblGrid>' +
        Array.from(
          { length: 17 },
          (_, row) =>
            '<w:tr>' +
            (row === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '') +
            Array.from(
              { length: 5 },
              (_, column) =>
                '<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/></w:tcPr>' +
                paragraph(`Cell ${group}-${row}-${column}: Editable table text 中文。`) +
                '</w:tc>',
            ).join('') +
            '</w:tr>',
        ).join('') +
        '</w:tbl>',
    )
    if (group % 2 === 0)
      body.push(
        '<w:p><w:r><w:pict><v:shape style="width:144pt;height:36pt">' +
          '<v:imagedata r:id="rId50"/></v:shape></w:pict></w:r></w:p>',
      )
    if (group % 6 === 5 && group + 1 < 17 * scale)
      body.push(`<w:p><w:pPr>${sections[Math.floor(group / 6) % sections.length]}</w:pPr></w:p>`)
  }
  body.push(paragraph(PERFORMANCE_END))
  return buildDocx({
    bodyXml: body.join(''),
    sectPrXml: sections[Math.floor((17 * scale - 1) / 6) % sections.length],
    docRootExtraAttrs: 'xmlns:v="urn:schemas-microsoft-com:vml"',
    extraRels:
      '<Relationship Id="rId50" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/equation.wmf"/>',
    binaryParts: [
      {
        path: 'word/media/equation.wmf',
        base64: wmf.toString('base64'),
        extension: 'wmf',
        contentType: 'image/x-wmf',
      },
    ],
  })
}

/** Independent OOXML tail oracle, used alongside pending-work and layout checks. */
export interface DocumentOracle {
  tail: string
  textRuns: string[]
  paragraphs: Array<{ text: string; start: number }>
  tables: string
  sections: string
}

export async function documentOracle(bytes: Uint8Array): Promise<DocumentOracle> {
  const archive = await JSZip.loadAsync(bytes)
  const xml = await archive.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('Input has no document XML')
  const parsed = new XMLParser({
    preserveOrder: true,
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
    ignoreAttributes: false,
  }).parse(xml)
  type Xml = Array<Record<string, unknown>>
  const document = (parsed as Xml).find((entry) => entry.document)?.document as Xml | undefined
  const body = document?.find((entry) => entry.body)?.body as Xml | undefined
  const text = (nodes: Xml): string =>
    nodes
      .flatMap((entry) =>
        Object.entries(entry).map(([key, value]) =>
          key === 't'
            ? text(value as Xml)
            : key === '#text'
              ? String(value)
              : Array.isArray(value)
                ? text(value as Xml)
                : '',
        ),
      )
      .join('')
  const tail = body
    ?.filter((entry) => entry.p)
    .map((entry) => text(entry.p as Xml).trim())
    .filter(Boolean)
    .at(-1)
  if (!tail)
    throw new Error('Input requires a nonempty final body paragraph as completeness oracle')
  const textRuns: string[] = []
  const sectionSpecs: unknown[] = []
  const paragraphs: DocumentOracle['paragraphs'] = []
  const tables: unknown[] = []
  let position = 0
  const properties = (nodes: Xml, names: string[]) =>
    nodes.filter((node) => names.some((name) => name in node))
  const visit = (nodes: Xml) => {
    for (const entry of nodes)
      for (const [key, value] of Object.entries(entry)) {
        if (key === 't') {
          const run = text(value as Xml).replace(/\s+/g, '')
          if (run) {
            textRuns.push(run)
            position += run.length
          }
        } else {
          if (key === 'p')
            paragraphs.push({ text: text(value as Xml).replace(/\s+/g, ''), start: position })
          if (key === 'tbl') {
            const table = value as Xml
            tables.push({
              properties: properties(table, ['tblPr', 'tblGrid']),
              rows: table
                .filter((row) => row.tr)
                .map((row) => {
                  const children = row.tr as Xml
                  return {
                    properties: properties(children, ['trPr']),
                    cells: children
                      .filter((cell) => cell.tc)
                      .map((cell) => properties(cell.tc as Xml, ['tcPr'])),
                  }
                }),
            })
          }
          if (key === 'sectPr') sectionSpecs.push(value)
          if (Array.isArray(value)) visit(value as Xml)
        }
      }
  }
  visit(body ?? [])
  return {
    tail,
    textRuns,
    paragraphs,
    tables: JSON.stringify(tables),
    sections: JSON.stringify(sectionSpecs),
  }
}

export async function documentTail(bytes: Uint8Array): Promise<string> {
  return (await documentOracle(bytes)).tail
}
