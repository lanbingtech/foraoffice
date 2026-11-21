// @vitest-environment node
import { expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import {
  buildPerformanceFixture,
  documentOracle,
  documentTail,
} from '../../../e2e/docs-performance-fixture'

it('generates identical public fixture bytes on different run dates', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    const first = await buildPerformanceFixture()
    vi.setSystemTime(new Date('2025-05-04T12:00:00Z'))
    const second = await buildPerformanceFixture()
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const zip = await JSZip.loadAsync(first)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:tbl>')
    expect(await documentTail(first)).toBe('PERFORMANCE DOCUMENT END')
    expect((await zip.file('word/media/equation.wmf')!.async('uint8array')).length).toBeGreaterThan(
      0,
    )
    expect((await documentOracle(first)).minimumBodyImages).toBe(9)
    const xml = new XMLParser({ ignoreAttributes: false }).parse(
      await zip.file('word/document.xml')!.async('string'),
    )
    const body = xml['w:document']['w:body']
    const sections = [
      ...body['w:p'].flatMap((p: Record<string, Record<string, unknown>>) =>
        p['w:pPr']?.['w:sectPr'] ? [p['w:pPr']['w:sectPr']] : [],
      ),
      body['w:sectPr'],
    ]
    expect(
      sections.map((section) => [
        section['w:pgSz']['@_w:w'],
        section['w:pgSz']['@_w:h'],
        section['w:pgSz']['@_w:orient'],
        section['w:pgMar']['@_w:left'],
        section['w:pgMar']['@_w:right'],
      ]),
    ).toEqual([
      ['11906', '16838', 'portrait', '1440', '1440'],
      ['16838', '11906', 'landscape', '720', '2160'],
      ['12240', '15840', 'portrait', '1800', '1080'],
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('counts picture placements rather than package parts and counts only one compatibility branch', async () => {
  const zip = new JSZip()
  const drawing = (contents: string) =>
    '<w:drawing><wp:inline><a:graphic><a:graphicData>' +
    contents +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>'
  const picture = (reference: string) =>
    drawing('<pic:pic><pic:blipFill><a:blip ' + reference + '/></pic:blipFill></pic:pic>')
  const embedded = picture('r:embed="rId1"')
  const fallback = '<w:pict><v:shape><v:imagedata r:id="rId2"/></v:shape></w:pict>'
  const alternate = (fallback: string) =>
    '<mc:AlternateContent><mc:Choice Requires="a">' +
    embedded +
    '</mc:Choice>' +
    fallback +
    '</mc:AlternateContent>'
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>' +
      '<w:p><w:r>' +
      embedded +
      embedded +
      alternate('<mc:Fallback>' + fallback + '</mc:Fallback>') +
      alternate('') +
      picture('r:link="external"') +
      drawing('<a:graphicFrame><a:blip r:embed="shape-fill"/></a:graphicFrame>') +
      embedded.replaceAll('wp:inline', 'wp:anchor') +
      fallback.replace('<v:shape>', '<v:shape style="position:absolute">') +
      '</w:r></w:p><w:p><w:r>' +
      fallback +
      '<w:pict><v:shape><v:textbox><w:txbxContent/></v:textbox></v:shape></w:pict>' +
      '</w:r></w:p><w:p><w:r><w:t>End</w:t></w:r></w:p></w:body></w:document>',
  )
  expect(
    (await documentOracle(await zip.generateAsync({ type: 'uint8array' }))).minimumBodyImages,
  ).toBe(3)
})

it('uses the final nonempty body paragraph rather than text inside a previous table', async () => {
  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Earlier</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Final </w:t></w:r><w:r><w:t>paragraph</w:t></w:r></w:p><w:p/></w:body></w:document>',
  )
  expect(await documentTail(await zip.generateAsync({ type: 'uint8array' }))).toBe(
    'Final paragraph',
  )
})

it('preserves a numeric text paragraph including leading zeroes in the completeness oracle', async () => {
  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>001</w:t></w:r></w:p></w:body></w:document>',
  )
  expect(await documentTail(await zip.generateAsync({ type: 'uint8array' }))).toBe('001')
})
