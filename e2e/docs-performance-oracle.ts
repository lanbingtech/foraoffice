import type { DocumentOracle } from './docs-performance-fixture'

const normalize = (text: string) => text.replace(/\s+/g, '')

export interface NativeCompositionEvent {
  type: string
  at: number
  data?: string | null
  trusted?: boolean
  mainEditor?: boolean
  twoFrameCallbacksMs?: number
}

/** Causal renderer evidence only; the independently guarded OS helper proves input origin. */
export function verifyNativeCompositionEvents(
  events: NativeCompositionEvent[],
  since: number,
  committed: string | null,
) {
  const sequence = events.filter((event) =>
    ['compositionstart', 'compositionupdate', 'compositionend'].includes(event.type),
  )
  const updates = sequence.filter((event) => event.type === 'compositionupdate')
  if (
    sequence[0]?.type !== 'compositionstart' ||
    sequence.at(-1)?.type !== 'compositionend' ||
    sequence.filter((event) => event.type === 'compositionstart').length !== 1 ||
    sequence.filter((event) => event.type === 'compositionend').length !== 1 ||
    !updates.some((event) => /[a-z]/.test(event.data ?? '')) ||
    sequence.some(
      (event, index) =>
        !event.mainEditor ||
        !Number.isFinite(event.at) ||
        event.at < since ||
        (index > 0 && event.at < sequence[index - 1].at) ||
        (event.type !== 'compositionend' && !event.trusted),
    )
  )
    throw new Error('Fresh owned native composition was not observed')
  const final = sequence.at(-1)!,
    update = updates.at(-1)!
  if (final.data !== (committed ?? '') || update.data !== (committed ?? ''))
    throw new Error('Native composition outcome differs from intended commit/cancel')
  if (!Number.isFinite(update.twoFrameCallbacksMs) || update.twoFrameCallbacksMs! < 0)
    throw new Error('Native current-update frame callbacks are missing')
  return {
    endTrusted: final.trusted,
    lastUpdateTwoFrameCallbacksMs: update.twoFrameCallbacksMs!,
    events: sequence.length,
  }
}

function hasExactInsertion(before: string, after: string, added: string | undefined): boolean {
  if (!added || after.length !== before.length + added.length) return false

  // Matching prefix and shifted suffix bound every valid insertion offset.
  let latest = 0
  while (latest < before.length && before[latest] === after[latest]) latest++
  let earliest = before.length
  while (earliest > 0 && before[earliest - 1] === after[earliest + added.length - 1]) earliest--

  const offset = after.indexOf(added, earliest)
  return offset >= 0 && offset <= latest
}

export function verifyKeyboardTextEdit(
  before: string,
  after: string,
  inserted: string | null,
  deleted?: string,
) {
  if (inserted === null) {
    if (!hasExactInsertion(after, before, deleted))
      throw new Error('Authored deletion differs from the selected preceding character')
  } else if (!hasExactInsertion(before, after, inserted))
    throw new Error('Authored insertion differs from the requested text')
}

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
  const targetIndex = original.paragraphs.indexOf(target)
  const paragraphs = original.paragraphs.map((item, index) =>
    item === target
      ? {
          ...item,
          text: item.text.slice(0, offset) + normalize(inserted) + item.text.slice(offset),
        }
      : {
          ...item,
          start:
            index > targetIndex && item.start >= position
              ? item.start + normalize(inserted).length
              : item.start,
        },
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
