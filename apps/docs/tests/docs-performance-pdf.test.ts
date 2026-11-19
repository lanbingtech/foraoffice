// @vitest-environment node
import { expect, it } from 'vitest'
import {
  verifyPositionedPdf,
  readPositionedPdf,
  type PdfSourceSnapshot,
  pdfExportBudget,
} from '../../../e2e/docs-performance-pdf'
import { PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, degrees } from 'pdf-lib'

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const snapshot: PdfSourceSnapshot = {
  pages: [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
  ],
  regions: [
    { page: 0, owner: 'body', role: 'body' as const, rect: rect(0, 0, 600, 80) },
    { page: 0, owner: 'T:0:0', role: 'body' as const, rect: rect(50, 100, 240, 600) },
    { page: 0, owner: 'T:0:1', role: 'body' as const, rect: rect(310, 100, 240, 600) },
    { page: 1, owner: 'T:0:0', role: 'body' as const, rect: rect(50, 50, 240, 450) },
    { page: 1, owner: 'T:0:1', role: 'body' as const, rect: rect(310, 50, 240, 450) },
    { page: 1, owner: 'body', role: 'body' as const, rect: rect(0, 600, 600, 100) },
  ],
}
const item = (text: string, x: number, y: number) => ({
  text,
  baselineY: y + 12,
  rect: rect(x, y, text.length * 5, 12),
})
const pages = [
  {
    width: 600,
    height: 800,
    items: [item('Before', 50, 30), item('Cell-A-start', 60, 120), item('Cell-B-start', 320, 120)],
  },
  {
    width: 600,
    height: 800,
    items: [item('-A-end', 60, 80), item('-B-end', 320, 80), item('AfterTail', 50, 630)],
  },
]
const expected = {
  body: 'BeforeAfterTail',
  'T:0:0': 'Cell-A-start-A-end',
  'T:0:1': 'Cell-B-start-B-end',
}

it('verifies interleaved multi-cell fragments by exact cell owner without imposing cross-cell PDF stream order', () => {
  expect(() => verifyPositionedPdf(expected, snapshot, pages)).not.toThrow()
})

it('rejects a lost continuation, wrong-cell text and reordered main body', () => {
  const missing = structuredClone(pages)
  missing[1].items.splice(0, 1)
  expect(() => verifyPositionedPdf(expected, snapshot, missing)).toThrow(
    'Printed source chain differs',
  )
  const wrongCell = structuredClone(pages)
  wrongCell[1].items[0].rect.x = 320
  expect(() => verifyPositionedPdf(expected, snapshot, wrongCell)).toThrow(
    'Printed source chain differs',
  )
  const reordered = structuredClone(pages)
  reordered[0].items[0].text = 'After'
  reordered[1].items[2].text = 'BeforeTail'
  expect(() => verifyPositionedPdf(expected, snapshot, reordered)).toThrow(
    'Printed source chain differs',
  )
})

it('rejects truncated, extra, mis-sized or blank pages and ambiguous item ownership', () => {
  expect(() => verifyPositionedPdf(expected, snapshot, pages.slice(0, 1))).toThrow(
    'PDF page count differs',
  )
  expect(() => verifyPositionedPdf(expected, snapshot, [...pages, pages[1]])).toThrow(
    'PDF page count differs',
  )
  const resized = structuredClone(pages)
  resized[1].height = 799
  expect(() => verifyPositionedPdf(expected, snapshot, resized)).toThrow('PDF page size differs')
  const blank = structuredClone(pages)
  blank[1].items = []
  expect(() => verifyPositionedPdf(expected, snapshot, blank)).toThrow(
    'Printed source chain differs',
  )
  const ambiguous = structuredClone(snapshot)
  ambiguous.regions.push({ ...snapshot.regions[1], owner: 'other-cell' })
  expect(() => verifyPositionedPdf(expected, ambiguous, pages)).toThrow(
    'Ambiguous printed text owner',
  )
})

it('reads real PDF text in page-relative top-left points and refuses an unaccounted rotated page', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 400])
  page.drawText('Cell source', { x: 20, y: 350, size: 12 })
  const actual = await readPositionedPdf(await pdf.save())
  expect(actual).toHaveLength(1)
  expect(actual[0]).toMatchObject({ width: 300, height: 400 })
  const text = actual[0].items.find((item) => item.text === 'Cell source')!
  expect(text.rect.x).toBeCloseTo(20)
  expect(text.rect.y).toBeCloseTo(38)
  expect(text.baselineY).toBeCloseTo(50)
  page.setRotation(degrees(90))
  await expect(readPositionedPdf(await pdf.save())).rejects.toThrow(
    'Unsupported PDF page coordinate conditions',
  )
})

it('allows only the documented Qt paper-size deviation without widening source-region ownership', () => {
  const qt = structuredClone(pages)
  qt.forEach((page) => {
    page.width -= 0.34004
    page.height -= 0.94004
  })
  expect(() => verifyPositionedPdf(expected, snapshot, qt, 'qt')).not.toThrow()
  expect(() => verifyPositionedPdf(expected, snapshot, qt, 'electron')).toThrow(
    'PDF page size differs',
  )
  qt[0].items[1].rect.x = 49.5
  expect(() => verifyPositionedPdf(expected, snapshot, qt, 'qt')).toThrow(
    'Printed text has no source geometry',
  )
})

it('accepts the measured browser paper rounding without moving source regions', () => {
  const browser = structuredClone(pages)
  browser[0].width += 0.6203
  browser[0].height += 0.0225
  expect(() => verifyPositionedPdf(expected, snapshot, browser, 'browser')).not.toThrow()

  browser[0].items[1].rect.x -= 10.5
  expect(() => verifyPositionedPdf(expected, snapshot, browser, 'browser')).toThrow(
    'Printed text has no source geometry',
  )
  browser[0].width = snapshot.pages[0].width + 0.76
  expect(() => verifyPositionedPdf(expected, snapshot, browser, 'browser')).toThrow(
    'PDF page size differs',
  )
})

it('requires a configured visible repeated header even when its entire PDF text disappears', () => {
  const repeated = structuredClone(snapshot)
  repeated.regions.push(
    { page: 0, owner: 'header-cell', role: 'body', rect: rect(40, 82, 80, 14) },
    { page: 1, owner: 'header-cell', role: 'repeat', rect: rect(40, 20, 80, 14) },
  )
  const output = structuredClone(pages)
  output[0].items.splice(1, 0, item('Heading', 45, 83))
  output[1].items.unshift(item('Heading', 45, 21))
  const source = { ...expected, 'header-cell': 'Heading' }
  expect(() => verifyPositionedPdf(source, repeated, output)).not.toThrow()
  output[1].items.shift()
  expect(() => verifyPositionedPdf(source, repeated, output)).toThrow(
    'Repeated printed header differs',
  )
})

it('rejects inverted and vertically sheared text matrices on an otherwise upright real PDF page', async () => {
  for (const options of [{ rotate: degrees(180) }, { xSkew: degrees(12) }]) {
    const pdf = await PDFDocument.create()
    pdf
      .addPage([300, 400])
      .drawText('Unsupported transform', { x: 100, y: 200, size: 12, ...options })
    await expect(readPositionedPdf(await pdf.save())).rejects.toThrow(
      'Unsupported rotated or sheared PDF text',
    )
  }
})

it('preserves the measured baseline and horizontal advance of real synthetic-italic PDF text', async () => {
  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400]).drawText('Synthetic italic', {
    x: 20,
    y: 350,
    size: 12,
    ySkew: degrees((Math.atan(0.25) * 180) / Math.PI),
  })
  const actual = await readPositionedPdf(await pdf.save())
  expect(actual[0].items[0].baselineY).toBeCloseTo(50)
  expect(actual[0].items[0].rect.x).toBeCloseTo(20)
  expect(actual[0].items[0].rect.width).toBeGreaterThan(60)
  expect(() =>
    verifyPositionedPdf(
      { body: 'Synthetic italic' },
      {
        pages: [{ width: 300, height: 400 }],
        regions: [{ page: 0, owner: 'body', role: 'body', rect: rect(19, 49.8, 100, 1) }],
      },
      actual,
    ),
  ).not.toThrow()
})

it('uses measured PDF baselines and the full horizontal span when an em box crosses a legitimate clip', () => {
  const output = structuredClone(pages)
  output[1].items[0].rect.y = 48.8
  output[1].items[0].baselineY = 60.8
  expect(() => verifyPositionedPdf(expected, snapshot, output)).not.toThrow()
  output[1].items[0].baselineY = 49
  expect(() => verifyPositionedPdf(expected, snapshot, output)).toThrow(
    'Printed text has no source geometry',
  )
})

it('bounds sequential native output using authored contiguous paper groups and the existing ten-page chunks', () => {
  const portrait = { width: 595.3, height: 841.9 }
  const landscape = { width: 841.9, height: 595.3 }
  expect(
    pdfExportBudget([
      ...Array.from({ length: 12 }, () => portrait),
      ...Array.from({ length: 2 }, () => landscape),
      ...Array.from({ length: 32 }, () => portrait),
    ]),
  ).toEqual({ initialJobs: 7, timeoutMs: 450_000, capMs: 600_000 })
  expect(pdfExportBudget(Array.from({ length: 200 }, () => portrait))).toEqual({
    initialJobs: 20,
    timeoutMs: 600_000,
    capMs: 600_000,
  })
  expect(() => pdfExportBudget([])).toThrow('Missing authored print pages')
})

it('reads the PDF 1.7 replacement text only for its single positioned item and keeps its raw text', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 400])
  page.drawText('a', { x: 20, y: 350, size: 12 })
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of('Span'),
      pdf.context.obj({ ActualText: PDFHexString.fromText('Ω') }).toString(),
    ]),
  )
  page.drawText('x', { x: 32, y: 350, size: 12 })
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
  page.drawText('after', { x: 20, y: 330, size: 12 })

  const bytes = await pdf.save()
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjs = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 })
  try {
    const pdfPage = await (await pdfjs.promise).getPage(1)
    const { items } = await pdfPage.getTextContent({ includeMarkedContent: true })
    const mark = items.findIndex(
      (item) => !('str' in item) && item.type === 'beginMarkedContentProps',
    )
    expect(items.slice(mark + 1, mark + 3)).toMatchObject([
      { str: ' ', height: 0, hasEOL: false },
      { str: 'x' },
    ])
  } finally {
    await pdfjs.destroy()
  }
  const positioned = await readPositionedPdf(bytes)
  expect(positioned[0].items).toMatchObject([
    { text: 'a', baselineY: 50, rect: { x: 20 } },
    { text: 'x', actualText: 'Ω', baselineY: 50, rect: { x: 32 } },
    { text: 'after', baselineY: 70, rect: { x: 20 } },
  ])
  expect(positioned[0].items[2].actualText).toBeUndefined()
  const proof = verifyPositionedPdf(
    { body: 'aΩafter' },
    {
      pages: [{ width: 300, height: 400 }],
      regions: [{ page: 0, owner: 'body', role: 'body', rect: rect(20, 40, 200, 40) }],
    },
    positioned,
  )
  expect(proof.actualTextReplacements).toBe(1)
})

it('keeps raw text for malformed replacements and spans that enclose fragments or other scopes', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 400])
  const end = PDFOperator.of(PDFOperatorNames.EndMarkedContent)
  const begin = (value: PDFHexString) =>
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of('Span'),
      pdf.context.obj({ ActualText: value }).toString(),
    ])
  let y = 360
  const draw = (text: string) => {
    page.drawText(text, { x: 20, y, size: 12 })
    y -= 24
  }

  for (const value of [
    PDFHexString.of(''),
    PDFHexString.fromText('AB'),
    PDFHexString.of('FEFFD800'),
  ]) {
    page.pushOperators(begin(value))
    draw('x')
    page.pushOperators(end)
  }
  const replacement = begin(PDFHexString.fromText('A'))
  page.pushOperators(replacement, end)
  draw('x')
  page.pushOperators(replacement)
  draw('xx')
  page.pushOperators(end)
  page.pushOperators(replacement)
  draw('x')
  draw('x')
  page.pushOperators(end)
  page.pushOperators(replacement, replacement)
  draw('x')
  page.pushOperators(end, end)

  const actual = await readPositionedPdf(await pdf.save())
  expect(actual[0].items.map((item) => item.text)).toEqual([
    'x',
    'x',
    'x',
    'x',
    'xx',
    'x',
    'x',
    'x',
  ])
  expect(actual[0].items.some((item) => item.actualText !== undefined)).toBe(false)
  const source: PdfSourceSnapshot = {
    pages: [{ width: 300, height: 400 }],
    regions: [{ page: 0, owner: 'body', role: 'body', rect: rect(0, 0, 300, 400) }],
  }
  expect(() => verifyPositionedPdf({ body: 'Axxxxxxxx' }, source, actual)).toThrow(
    'Printed source chain differs',
  )
})

it.each(['unbalanced scope', 'duplicate property'])(
  'keeps the raw strict path for a %s',
  async (variant) => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([300, 400])
    const props =
      variant === 'duplicate property'
        ? '<< /ActualText <FEFF0041> /ActualText <FEFF0042> >>'
        : '<< /ActualText <FEFF0041> >>'
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('Span'), props]),
    )
    page.drawText('x', { x: 20, y: 350, size: 12 })
    if (variant === 'duplicate property')
      page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
    const actual = await readPositionedPdf(await pdf.save())
    expect(actual[0].items).toMatchObject([{ text: 'x' }])
    expect(actual[0].items[0].actualText).toBeUndefined()
  },
)

it('keeps two nonblank items unchanged when one replacement scope contains both', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 400])
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of('Span'),
      '<< /ActualText <FEFF0041> >>',
    ]),
  )
  page.drawText('x', { x: 20, y: 350, size: 12 })
  page.drawText('y', { x: 20, y: 330, size: 12 })
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
  const actual = await readPositionedPdf(await pdf.save())
  expect(actual[0].items.map((it) => [it.text, it.actualText])).toEqual([
    ['x', undefined],
    ['y', undefined],
  ])
})
