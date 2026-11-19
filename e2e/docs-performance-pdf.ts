export interface PdfRect {
  x: number
  y: number
  width: number
  height: number
}
export interface PdfTextPage {
  width: number
  height: number
  items: Array<{ text: string; rect: PdfRect; baselineY: number }>
}
export interface PdfSourceSnapshot {
  pages: Array<{ width: number; height: number }>
  regions: Array<{ page: number; owner: string; role: 'body' | 'repeat'; rect: PdfRect }>
}

export async function readPositionedPdf(bytes: Uint8Array): Promise<PdfTextPage[]> {
  // Same installed PDF.js path as existing Docs output geometry tests.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 })
  try {
    const pdf = await task.promise
    const result: PdfTextPage[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      if (page.rotate !== 0 || page.userUnit !== 1 || page.view[0] !== 0 || page.view[1] !== 0)
        throw new Error('Unsupported PDF page coordinate conditions')
      const viewport = page.getViewport({ scale: 1 })
      const text = await page.getTextContent()
      const items: PdfTextPage['items'] = []
      for (const item of text.items) {
        if (!('str' in item) || !item.str.trim()) continue
        const matrix = item.transform as number[]
        const [a, b, , d, x, y] = matrix
        if (item.dir !== 'ltr') throw new Error('Unsupported non-LTR PDF text')
        if (
          matrix.length !== 6 ||
          matrix.some((value) => !Number.isFinite(value)) ||
          a <= 0 ||
          d <= 0 ||
          Math.abs(b) > 1e-6
        )
          throw new Error('Unsupported rotated or sheared PDF text')
        // A finite horizontal shear (synthetic italic) changes glyph ink above the
        // baseline, but preserves this LTR baseline and PDF.js horizontal advance.
        const point = viewport.convertToViewportPoint(x, y)
        items.push({
          text: item.str,
          baselineY: point[1],
          rect: { x: point[0], y: point[1] - item.height, width: item.width, height: item.height },
        })
      }
      result.push({ width: viewport.width, height: viewport.height, items })
      page.cleanup()
    }
    return result
  } finally {
    await task.destroy()
  }
}

const normalize = (text: string) => text.replace(/\s+/g, '')
const regionTolerance = 0.25
const contains = (outer: PdfRect, inner: PdfRect) =>
  inner.x >= outer.x - regionTolerance &&
  inner.y >= outer.y - regionTolerance &&
  inner.x + inner.width <= outer.x + outer.width + regionTolerance &&
  inner.y + inner.height <= outer.y + outer.height + regionTolerance

/** Geometry assigns a source owner; only that owner's source text may satisfy its chain. */
export function verifyPositionedPdf(
  expected: Record<string, string>,
  snapshot: PdfSourceSnapshot,
  pages: PdfTextPage[],
  host: 'qt' | 'electron' | 'browser' = 'browser',
) {
  // Recorded Qt6.11.1 A4 output differs by up to0.94004pt from authored paper.
  // This allowance applies only to paper dimensions; no source region is rescaled.
  const paperTolerance = host === 'qt' ? 1 : 0.25
  if (!expected.body?.trim()) throw new Error('Independent main body expectation is missing')
  if (pages.length !== snapshot.pages.length || !pages.length)
    throw new Error('PDF page count differs from authored preview')
  const actual = new Map<string, string>()
  const repeated = new Map<string, { owner: string; text: string }>()
  pages.forEach((page, pageIndex) => {
    const source = snapshot.pages[pageIndex]
    if (
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      !Number.isFinite(source.width) ||
      !Number.isFinite(source.height) ||
      source.width <= 0 ||
      source.height <= 0 ||
      Math.abs(page.width - source.width) > paperTolerance ||
      Math.abs(page.height - source.height) > paperTolerance
    )
      throw new Error('PDF page size differs from authored preview')
    for (const item of page.items) {
      const text = normalize(item.text)
      if (!text) continue
      if (
        !Number.isFinite(item.baselineY) ||
        !Number.isFinite(item.rect.x) ||
        !Number.isFinite(item.rect.width) ||
        item.rect.width < 0
      )
        throw new Error('PDF baseline geometry is missing or invalid')
      // PDF em height can cross a legitimate clip while the actual baseline remains inside.
      // Retain the raw em box, and bind semantics by measured baseline plus full advance span.
      const placement = { x: item.rect.x, y: item.baselineY, width: item.rect.width, height: 0 }
      let owners = snapshot.regions.filter(
        (region) => region.page === pageIndex && contains(region.rect, placement),
      )
      if (owners.some((region) => region.owner !== 'body'))
        owners = owners.filter((region) => region.owner !== 'body')
      const unique = new Map(owners.map((region) => [`${region.owner}/${region.role}`, region]))
      if (unique.size !== 1)
        throw new Error(
          unique.size ? 'Ambiguous printed text owner' : 'Printed text has no source geometry',
        )
      const owner = [...unique.values()][0]
      if (!Object.hasOwn(expected, owner.owner))
        throw new Error('Printed text has no independent source chain')
      if (owner.role === 'repeat') {
        const key = `${pageIndex}/${owner.owner}`
        const previous = repeated.get(key)
        repeated.set(key, { owner: owner.owner, text: (previous?.text ?? '') + text })
      } else actual.set(owner.owner, (actual.get(owner.owner) ?? '') + text)
    }
  })
  for (const [owner, text] of Object.entries(expected))
    if (normalize(text) !== (actual.get(owner) ?? ''))
      throw new Error(`Printed source chain differs: ${owner}`)
  const requiredRepeats = new Map(
    snapshot.regions
      .filter((region) => region.role === 'repeat')
      .map((region) => [`${region.page}/${region.owner}`, region.owner]),
  )
  for (const [key, owner] of requiredRepeats) {
    if (!Object.hasOwn(expected, owner))
      throw new Error('Repeated header has no independent source chain')
    if ((repeated.get(key)?.text ?? '') !== normalize(expected[owner]))
      throw new Error(`Repeated printed header differs: ${owner}`)
  }
  return {
    pages: pages.length,
    sourceChains: Object.keys(expected).length,
    repeatedHeaders: repeated.size,
    paperTolerancePoints: paperTolerance,
    regionTolerancePoints: regionTolerance,
    paperDimensions: pages.map((page, index) => ({
      expected: snapshot.pages[index],
      actual: { width: page.width, height: page.height },
    })),
  }
}
