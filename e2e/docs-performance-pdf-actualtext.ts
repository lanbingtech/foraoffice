import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from 'pdf-lib'
import byteStreamModule from 'pdf-lib/cjs/core/parser/ByteStream.js'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js'

// pdf-lib exposes this parser helper through its pinned CommonJS package.
const ByteStream =
  'default' in byteStreamModule
    ? (byteStreamModule.default as typeof byteStreamModule)
    : byteStreamModule

const ws = new Set([0, 9, 10, 12, 13, 32])
const delimiters = new Set(Array.from('()<>[]{}/%', (char) => char.charCodeAt(0)))
const paintOps = new Set([
  'Tj',
  'TJ',
  "'",
  '"',
  'Do',
  'S',
  's',
  'f',
  'F',
  'f*',
  'B',
  'B*',
  'b',
  'b*',
  'sh',
])

class ContentParser extends PDFObjectParser {
  protected parseDict() {
    this.bytes.assertNext(60)
    this.bytes.assertNext(60)
    const entries = new Map<PDFName, PDFObject>()
    this.skipWhitespaceAndComments()
    while (!this.bytes.done() && this.bytes.peek() !== 62) {
      const key = this.parseName()
      if (entries.has(key)) throw new Error('Duplicate PDF property')
      entries.set(key, this.parseObject())
      this.skipWhitespaceAndComments()
    }
    this.bytes.assertNext(62)
    this.bytes.assertNext(62)
    return PDFDict.fromMapWithContext(entries, this.context)
  }
}

function* operators(file: PDFDocument, bytes: Uint8Array) {
  const stream = ByteStream.of(bytes)
  const parser = new ContentParser(stream, file.context)
  let operands: PDFObject[] = []
  while (!stream.done()) {
    const byte = stream.peek()
    if (ws.has(byte)) {
      stream.next()
      continue
    }
    if (byte === 37) {
      while (!stream.done() && ![10, 13].includes(stream.next())) {
        // Skip the PDF comment through end of line.
      }
      continue
    }
    if ([47, 40, 60, 91, 43, 45, 46].includes(byte) || (byte >= 48 && byte <= 57)) {
      const start = stream.offset()
      operands.push(parser.parseObject())
      if (stream.offset() <= start) throw new Error('Invalid PDF operand')
      continue
    }
    if (delimiters.has(byte)) throw new Error('Invalid PDF delimiter')
    let op = ''
    while (!stream.done() && !ws.has(stream.peek()) && !delimiters.has(stream.peek())) {
      op += String.fromCharCode(stream.next())
    }
    if (['true', 'false', 'null'].includes(op)) {
      operands.push(PDFObjectParser.forBytes(Buffer.from(op), file.context).parseObject())
      continue
    }
    if (['BI', 'ID', 'EI'].includes(op)) throw new Error('Inline image content is unsupported')
    yield { op, operands }
    operands = []
  }
  if (operands.length) throw new Error('Unterminated PDF operator')
}

type Mark = { op: 'BMC' | 'BDC' | 'EMC'; tag?: string; mcid?: number; actualText?: string }

function scalar(text: string) {
  return /^[^\s\uD800-\uDFFF\uFFFD]$/u.test(text)
}

function decodeActualText(value: PDFObject | undefined) {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return
  const bytes = value.asBytes()
  let text: string
  if (bytes.length === 1) text = value.decodeText()
  else if ((bytes.length === 4 || bytes.length === 6) && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
    } catch {
      return
    }
  } else return
  if (scalar(text)) return text
}

const name = PDFName.of
function hasType3Character(font: PDFDict, encoding: PDFDict, code: number) {
  // ISO 32000-1 §9.6.5: the Type 3 encoding selects a CharProcs stream, and Widths gives its advance.
  const first = font.lookupMaybe(name('FirstChar'), PDFNumber)?.asNumber()
  const last = font.lookupMaybe(name('LastChar'), PDFNumber)?.asNumber()
  if (
    first === undefined ||
    last === undefined ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    code < first ||
    code > last
  )
    return false
  const widths = font.lookupMaybe(name('Widths'), PDFArray)
  const width = widths?.lookupMaybe(code - first, PDFNumber)?.asNumber()
  const matrix = font.lookupMaybe(name('FontMatrix'), PDFArray)
  const xScale = matrix?.lookupMaybe(0, PDFNumber)?.asNumber()
  if (
    !width ||
    width < 0 ||
    !Number.isFinite(width) ||
    !xScale ||
    xScale < 0 ||
    !Number.isFinite(xScale)
  )
    return false

  const differences = encoding.lookupMaybe(name('Differences'), PDFArray)
  if (!differences) return false
  let index = -1
  let glyph: PDFName | undefined
  for (const entry of differences.asArray()) {
    if (entry instanceof PDFNumber) index = entry.asNumber()
    else if (entry instanceof PDFName && Number.isInteger(index) && index >= 0 && index <= 255) {
      if (index === code) {
        if (glyph) return false
        glyph = entry
      }
      index++
    } else return false
  }
  return (
    glyph !== undefined &&
    font.lookupMaybe(name('CharProcs'), PDFDict)?.lookup(glyph) instanceof PDFRawStream
  )
}

function isSingleCharacterCode(font: PDFDict | undefined, text: PDFString | PDFHexString) {
  if (!font) return false
  const subtype = font.lookupMaybe(name('Subtype'), PDFName)?.decodeText()
  const encoding = font.lookup(name('Encoding'))
  const bytes = text.asBytes()
  if (subtype === 'Type0')
    return (
      bytes.length === 2 && encoding instanceof PDFName && encoding.decodeText() === 'Identity-H'
    )
  if (bytes.length !== 1) return false
  if (subtype === 'Type3')
    return encoding instanceof PDFDict && hasType3Character(font, encoding, bytes[0])
  return (
    (subtype === 'Type1' || subtype === 'TrueType') &&
    encoding instanceof PDFName &&
    encoding.decodeText() === 'WinAnsiEncoding'
  )
}

function readRawMarks(file: PDFDocument, pageIndex: number): Mark[] {
  const page = file.getPage(pageIndex)
  const resources = page.node.Resources()
  const content = page.node.Contents()
  const streams =
    content instanceof PDFArray
      ? Array.from({ length: content.size() }, (_, i) => content.lookup(i, PDFRawStream))
      : [content]
  const bytes = Buffer.concat(
    streams.flatMap((stream) => {
      if (!(stream instanceof PDFRawStream)) throw new Error('Unsupported PDF page content')
      return [decodePDFRawStream(stream).decode(), Buffer.from('\n')]
    }),
  )
  const events: Mark[] = []
  const scopes: Array<{
    mark: Mark
    hasActualText: boolean
    replacement?: string
    paints: number
  }> = []
  const graphics: Array<PDFDict | undefined> = []
  let font: PDFDict | undefined
  let inText = false
  for (const { op, operands } of operators(file, bytes)) {
    const [first, second] = operands
    const scope = scopes.at(-1)
    if (op === 'q') graphics.push(font)
    else if (op === 'Q') {
      if (!graphics.length) throw new Error('Unbalanced PDF graphics scope')
      font = graphics.pop()
    } else if (op === 'Tf') {
      font =
        operands.length === 2 &&
        first instanceof PDFName &&
        second instanceof PDFNumber &&
        second.asNumber() > 0
          ? resources?.lookupMaybe(name('Font'), PDFDict)?.lookupMaybe(first, PDFDict)
          : undefined
    } else if (op === 'gs' && first instanceof PDFName) {
      const state = resources?.lookupMaybe(name('ExtGState'), PDFDict)?.lookupMaybe(first, PDFDict)
      if (!state || state.has(name('Font'))) font = undefined
    } else if (op === 'BT' || op === 'ET') {
      if (inText === (op === 'BT')) throw new Error('Unbalanced PDF text scope')
      inText = op === 'BT'
    } else if (op === 'Do') {
      const objects = resources?.lookupMaybe(name('XObject'), PDFDict)
      const object = first instanceof PDFName ? objects?.lookup(first) : undefined
      if (
        !(object instanceof PDFRawStream) ||
        object.dict.lookupMaybe(name('Subtype'), PDFName)?.decodeText() !== 'Image'
      )
        throw new Error('Form XObject marked content is unsupported')
    }

    if (op === 'BMC' || op === 'BDC') {
      if (
        !(first instanceof PDFName) ||
        (op === 'BMC'
          ? operands.length !== 1
          : operands.length !== 2 || !(second instanceof PDFDict))
      )
        throw new Error('Unsupported PDF marked-content properties')
      const props = second instanceof PDFDict ? second : undefined
      const actualText = props?.get(name('ActualText'))
      const mark = {
        op,
        tag: first.decodeText(),
        mcid: props?.lookupMaybe(name('MCID'), PDFNumber)?.asNumber(),
      } satisfies Mark
      const replacement =
        op === 'BDC' && mark.tag === 'Span' && !scopes.some((entry) => entry.hasActualText)
          ? decodeActualText(actualText)
          : undefined
      if (scope) scope.replacement = undefined
      events.push(mark)
      scopes.push({ mark, hasActualText: actualText !== undefined, replacement, paints: 0 })
    } else if (op === 'EMC') {
      if (!scope || operands.length) throw new Error('Invalid PDF marked-content end')
      scopes.pop()
      if (scope.paints === 1) scope.mark.actualText = scope.replacement
      events.push({ op })
    } else if (scope?.replacement && paintOps.has(op)) {
      scope.paints++
      if (
        op !== 'Tj' ||
        operands.length !== 1 ||
        !inText ||
        !(first instanceof PDFString || first instanceof PDFHexString) ||
        !isSingleCharacterCode(font, first)
      )
        scope.replacement = undefined
    }
  }
  if (scopes.length || graphics.length || inText) throw new Error('Unbalanced PDF page content')
  return events
}

function itemTag(item: TextContent['items'][number]) {
  return 'tag' in item && typeof item.tag === 'string' ? item.tag : undefined
}

function matchMarks(items: TextContent['items'], events: Mark[]) {
  const replacements = new Map<TextItem, string>()
  const scopes: Array<{ mark: Mark; items: number; text?: TextItem }> = []
  let ordinal = 0
  for (const item of items) {
    const scope = scopes.at(-1)
    if ('str' in item) {
      // PDF.js can emit a synthetic gap before the one glyph, even inside its mark.
      if (
        item.str === ' ' &&
        item.height === 0 &&
        item.hasEOL === false &&
        Number.isFinite(item.width) &&
        item.width > 0
      )
        continue
      if (scope) {
        scope.items++
        scope.text = item
      }
      continue
    }
    const op = {
      beginMarkedContent: 'BMC',
      beginMarkedContentProps: 'BDC',
      endMarkedContent: 'EMC',
    }[item.type]
    const mark = events[ordinal++]
    const mcid = item.id == null ? undefined : Number(/_mc(-?\d+)$/.exec(item.id)?.[1])
    if (!mark || mark.op !== op || mark.tag !== itemTag(item) || mark.mcid !== mcid) return
    if (op === 'EMC') {
      if (!scope) return
      scopes.pop()
      const text = scope.text
      if (
        scope.items === 1 &&
        text &&
        scalar(text.str) &&
        scope.mark.actualText &&
        scope.mark.actualText !== text.str
      )
        replacements.set(text, scope.mark.actualText)
    } else scopes.push({ mark, items: 0 })
  }
  if (!scopes.length && ordinal === events.length) return replacements
}

/** ISO 32000-1 §14.9.4 gives /ActualText the scope of its marked-content sequence.
 * PDF.js exposes the boundaries, while the PDF stream supplies the exact text. */
export function createPdfActualTextReader(bytes: Uint8Array) {
  let file: Promise<PDFDocument> | undefined
  return async (pageIndex: number, items: TextContent['items']) => {
    if (
      !items.some(
        (item) =>
          !('str' in item) && item.type === 'beginMarkedContentProps' && itemTag(item) === 'Span',
      )
    )
      return
    try {
      file ??= PDFDocument.load(bytes)
      return matchMarks(items, readRawMarks(await file, pageIndex))
    } catch {
      // The positioned reader can still compare raw text when a scope cannot be proved.
      return
    }
  }
}
