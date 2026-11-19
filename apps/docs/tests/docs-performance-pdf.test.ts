// @vitest-environment node
import { expect, it } from 'vitest'
import { verifyPositionedPdf, readPositionedPdf } from '../../../e2e/docs-performance-pdf'
import { PDFDocument, degrees } from 'pdf-lib'

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
const snapshot = {
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
