import type { DocumentOracle } from './docs-performance-fixture'

const normalize = (text: string) => text.replace(/\s+/g, '')

export function expectedInsertion(
  original: DocumentOracle,
  paragraph: string,
  offset: number,
  inserted: string,
): DocumentOracle {
  const matches = original.paragraphs.filter((item) => item.text === normalize(paragraph))
  if (matches.length !== 1)
    throw new Error('Intended edit must identify exactly one original paragraph')
  const target = matches[0]
  if (offset < 0 || offset > target.text.length) throw new Error('Invalid intended edit offset')
  const position = target.start + offset
  const all = original.textRuns.join('')
  const edited = all.slice(0, position) + normalize(inserted) + all.slice(position)
  const paragraphs = original.paragraphs.map((item) =>
    item === target
      ? {
          ...item,
          text: item.text.slice(0, offset) + normalize(inserted) + item.text.slice(offset),
        }
      : { ...item },
  )
  let start = 0
  const textRuns = original.textRuns
    .flatMap((run) => {
      const index = position - start
      start += run.length
      return index >= 0 && index < run.length
        ? [run.slice(0, index), normalize(inserted), run.slice(index)]
        : [run]
    })
    .filter(Boolean)
  if (textRuns.join('') !== edited)
    throw new Error('Intended insertion could not be attributed to original text')
  return { ...original, textRuns, paragraphs }
}

export function verifySavedContent(expected: DocumentOracle, saved: DocumentOracle): void {
  if (
    expected.textRuns.join('') !== saved.textRuns.join('') ||
    JSON.stringify(expected.paragraphs.map((p) => p.text)) !==
      JSON.stringify(saved.paragraphs.map((p) => p.text))
  )
    throw new Error('Saved text or paragraph boundaries differ from original plus intended edit')
  if (expected.tables !== saved.tables) throw new Error('Saved tables differ from original')
  if (expected.sections !== saved.sections) throw new Error('Saved sections differ from original')
  if (JSON.stringify(expected.opaqueXml) !== JSON.stringify(saved.opaqueXml))
    throw new Error('Saved opaque source XML differs from original')
  if (JSON.stringify(expected.relationships) !== JSON.stringify(saved.relationships))
    throw new Error('Saved package relationships differ from original')
}

export function verifyPrintedContent(
  expected: DocumentOracle,
  printed: string,
  pages: number,
  visiblePages: number,
): void {
  if (!Number.isInteger(visiblePages) || visiblePages < 1 || pages !== visiblePages)
    throw new Error('PDF pages differ from the visible page total under default print conditions')
  const text = normalize(printed)
  let position = 0
  for (const run of expected.textRuns) {
    const found = text.indexOf(run, position)
    if (found < 0) throw new Error('PDF text is incomplete or out of order')
    position = found + run.length
  }
}

/** Serialized by Playwright and evaluated against the real document DOM. */
export function documentZoom(pm: HTMLElement): string {
  const owner = pm.closest<HTMLElement>('.doc-zoom')
  if (!owner) throw new Error('Document zoom owner is missing')
  return getComputedStyle(owner).zoom || '1'
}
