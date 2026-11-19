// @vitest-environment node
import { expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { buildPerformanceFixture, documentTail } from '../../../e2e/docs-performance-fixture'

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
