import { authoredTocLeaders } from './docs-performance-fixture'

export interface PdfTocLeader {
  prefix: string
  suffix: string
  minimum: number
  maximum: number
}

export function matchesPrintedTocLeader(actual: string, expected: PdfTocLeader) {
  if (!actual.startsWith(expected.prefix) || !actual.endsWith(expected.suffix)) return false
  const count = actual.length - expected.prefix.length - expected.suffix.length
  if (count < expected.minimum || count > expected.maximum) return false
  return actual.slice(expected.prefix.length, expected.prefix.length + count) === '.'.repeat(count)
}

export function projectPrintedTocLeaders(
  documentXml: string,
  source: Record<string, string>,
  observed: ReadonlyArray<{ anchor: string; page: number; minimum: number; maximum: number }>,
) {
  const leaders: Record<string, PdfTocLeader> = {}
  const sourceBody: string[] = []
  let position = 0
  let covered = 0
  for (const entry of authoredTocLeaders(documentXml)) {
    const matches = observed.filter((item) => item.anchor === entry.anchor)
    if (matches.length !== 1)
      throw new Error('Authored TOC leader has no unique printed source region')
    const owner = `toc:${entry.anchor}`
    if (Object.hasOwn(leaders, owner)) throw new Error('Printed TOC leader anchor is ambiguous')
    const { minimum, maximum } = matches[0]
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum < 0 ||
      maximum <= 0 ||
      maximum < minimum
    )
      throw new Error('Printed TOC leader has invalid measured character bounds')
    const offset = source.body.indexOf(entry.authored, position)
    if (offset < 0 || source.body.indexOf(entry.authored, offset + 1) !== -1)
      throw new Error('Authored TOC entry is missing or ambiguous in its body source')
    sourceBody.push(source.body.slice(position, offset))
    position = offset + entry.authored.length
    leaders[owner] = { prefix: entry.prefix, suffix: entry.suffix, minimum, maximum }
    covered++
  }
  if (covered !== observed.length)
    throw new Error('Printed TOC leader has no independently authored tab')
  sourceBody.push(source.body.slice(position))
  return { chains: { ...source, body: sourceBody.join(''), ...leaders }, leaders }
}
