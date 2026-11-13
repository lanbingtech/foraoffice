// Modified for ForaOffice from GenOffice v0.12.852.
import { LENGTH_DESC, ANCHORS, WRAPS } from '../../shared/floating-tool-schema'
export {
  SET_WATERMARK_TOOL,
  INSERT_PICTURE_TOOL,
  INSERT_TEXT_BOX_TOOL,
} from '../../shared/floating-tool-schema'
import type { Editor, JSONContent } from '@tiptap/core'
import {
  buildAnchoredTextboxParagraphXml,
  type ImageWrap,
  type NewImage,
  type PictureWatermarkSpec,
  type Run,
  type TextboxDisplay,
  type Watermark,
  type WatermarkSpec,
} from '@genoffice/docx-engine'
import { blockRangePositions } from './doc-utils'
import { emuToPx, parseEmu, parsePoints } from './lengths'
import { MAX_FONT_SIZE_PT, MIN_FONT_SIZE_PT } from './ops'

/** App- or CLI-owned watermark state; the header part is rewritten on save. */
export interface AiWatermarkAccess {
  /** current text watermark, null when the header has none (or carries a picture) */
  current(): string | null
  /** returns an error message, or null on success */
  set(spec: WatermarkSpec | PictureWatermarkSpec | null): string | null
}

export type { Watermark }

const HEX = /^#?([0-9a-f]{6})$/i

export interface ResolvedWatermarkImage {
  base64: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif'
  widthPx: number
  heightPx: number
}

/** Field check for the picture variant; the caller has already fetched and measured the image. */
export function resolvePictureWatermark(
  input: Record<string, unknown>,
  image: ResolvedWatermarkImage,
): { spec: PictureWatermarkSpec } | { error: string } {
  if (input.text !== undefined && input.text !== null)
    return { error: 'give text or image, not both' }
  const spec: PictureWatermarkSpec = { image }
  if (input.scale !== undefined) {
    if (typeof input.scale !== 'number' || !(input.scale > 0) || input.scale > 1000)
      return { error: 'scale must be a percent between 0 and 1000' }
    spec.scale = input.scale
  }
  if (input.washout !== undefined) {
    if (typeof input.washout !== 'boolean') return { error: 'washout must be true or false' }
    spec.washout = input.washout
  }
  return { spec }
}

export function resolveWatermark(
  input: Record<string, unknown>,
): { spec: WatermarkSpec | null } | { error: string } {
  if (input.text === null || (input.image === null && input.text === undefined))
    return { spec: null }
  if (typeof input.image === 'string')
    return { error: 'a picture watermark needs the image resolved first' }
  if (typeof input.text !== 'string' || !input.text.trim())
    return {
      error:
        'text must be a non-empty string (or image an image URL); null for either removes the watermark',
    }
  if (input.text.length > 200)
    return { error: 'text is too long for a watermark (200 characters max)' }
  const spec: WatermarkSpec = { text: input.text.trim() }
  if (input.fontFamily !== undefined) {
    if (typeof input.fontFamily !== 'string' || !input.fontFamily.trim())
      return { error: 'fontFamily must be a font name' }
    spec.fontFamily = input.fontFamily.trim()
  }
  if (input.color !== undefined) {
    const m = typeof input.color === 'string' ? HEX.exec(input.color.trim()) : null
    if (!m) return { error: 'color must be "#RRGGBB"' }
    spec.colorHex = m[1]!.toUpperCase()
  }
  if (input.opacity !== undefined) {
    if (typeof input.opacity !== 'number' || input.opacity < 0 || input.opacity > 1)
      return { error: 'opacity must be between 0 and 1' }
    spec.opacity = input.opacity
  }
  for (const k of ['diagonal', 'bold', 'italic'] as const) {
    if (input[k] === undefined) continue
    if (typeof input[k] !== 'boolean') return { error: `${k} must be true or false` }
    spec[k] = input[k] as boolean
  }
  return { spec }
}

type Anchor = (typeof ANCHORS)[number]

type Wrap = (typeof WRAPS)[number]

const WRAP_TO_IMAGE: Record<Wrap, ImageWrap> = {
  square: 'square-left',
  tight: 'tight-left',
  topAndBottom: 'topBottom',
  behind: 'behind',
  inFront: 'front',
}

export interface FloatSpec {
  anchor: Anchor
  xEmu: number
  yEmu: number
  wrap: Wrap
}

export function resolveFloat(value: unknown): { float: FloatSpec } | { error: string } {
  if (!value || typeof value !== 'object')
    return { error: 'float must be an object { anchor?, x, y, wrap? }' }
  const f = value as Record<string, unknown>
  const anchor = f.anchor === undefined ? 'paragraph' : f.anchor
  if (!ANCHORS.includes(anchor as Anchor))
    return { error: `float.anchor must be one of ${ANCHORS.join(', ')}` }
  const wrap = f.wrap === undefined ? 'square' : f.wrap
  if (!WRAPS.includes(wrap as Wrap))
    return { error: `float.wrap must be one of ${WRAPS.join(', ')}` }
  const xEmu = parseEmu(f.x, 'pt')
  const yEmu = parseEmu(f.y, 'pt')
  if (xEmu === undefined || yEmu === undefined)
    return { error: `float.x and float.y must be ${LENGTH_DESC}` }
  return { float: { anchor: anchor as Anchor, xEmu, yEmu, wrap: wrap as Wrap } }
}

export interface PictureInput {
  base64: string
  mime: NewImage['mime']
  naturalWidth: number
  naturalHeight: number
  width?: unknown
  height?: unknown
  float?: FloatSpec
  altText?: string
  label?: string
}

/** The protected image block for a new picture: inline, or anchored when `float` is given. */
export function pictureNode(
  input: PictureInput,
): { node: JSONContent; widthPx: number; heightPx: number } | { error: string } {
  const wEmu = input.width === undefined ? undefined : parseEmu(input.width, 'pt')
  const hEmu = input.height === undefined ? undefined : parseEmu(input.height, 'pt')
  if ((input.width !== undefined && !wEmu) || (input.height !== undefined && !hEmu))
    return { error: `width and height must be ${LENGTH_DESC}` }
  const ratio = input.naturalWidth / Math.max(1, input.naturalHeight)
  let widthPx: number
  let heightPx: number
  if (wEmu && hEmu) {
    widthPx = emuToPx(wEmu)
    heightPx = emuToPx(hEmu)
  } else if (wEmu) {
    widthPx = emuToPx(wEmu)
    heightPx = Math.round(widthPx / ratio)
  } else if (hEmu) {
    heightPx = emuToPx(hEmu)
    widthPx = Math.round(heightPx * ratio)
  } else {
    const scale = Math.min(1, 480 / input.naturalWidth)
    widthPx = Math.round(input.naturalWidth * scale)
    heightPx = Math.round(input.naturalHeight * scale)
  }
  widthPx = Math.max(1, widthPx)
  heightPx = Math.max(1, heightPx)
  const genImage: NewImage = {
    base64: input.base64,
    mime: input.mime,
    widthPx,
    heightPx,
    ...(input.altText ? { altText: input.altText } : {}),
  }
  const attrs: Record<string, unknown> = {
    docxIndex: null,
    blockType: 'image',
    label: input.label ?? 'Picture',
    imageDataUrl: `data:${input.mime};base64,${input.base64}`,
    imageWidthPx: widthPx,
    imageHeightPx: heightPx,
  }
  if (input.float) {
    const { anchor, xEmu, yEmu, wrap } = input.float
    genImage.wrap = WRAP_TO_IMAGE[wrap]
    genImage.posOffsetEmu = {
      x: xEmu,
      y: yEmu,
      ...(anchor === 'paragraph' ? {} : { relativeTo: anchor }),
    }
    attrs.imageWrap = genImage.wrap
    attrs.imageOffsetXEmu = xEmu
    attrs.imageOffsetYEmu = yEmu
    if (anchor !== 'paragraph') attrs.imageRelV = anchor
  }
  attrs.genImage = genImage
  return { node: { type: 'docProtected', attrs }, widthPx, heightPx }
}

/** top-level position after block `after` (-1 = document start); error text when out of range */
export function insertPosition(
  editor: Editor,
  after: unknown,
): { pos: number; after: number } | { error: string } {
  const count = editor.state.doc.childCount
  const index = after === undefined || after === null ? count - 1 : Number(after)
  if (!Number.isInteger(index) || index < -1 || index >= count)
    return { error: `afterBlockIndex must be -1..${count - 1} (the document has ${count} blocks)` }
  return { pos: index < 0 ? 0 : blockRangePositions(editor, index, index).to, after: index }
}

function hexOrNull(
  value: unknown,
  field: string,
  dflt: string,
): { hex: string | undefined } | { error: string } {
  if (value === undefined) return { hex: dflt }
  if (value === null) return { hex: undefined }
  const m = typeof value === 'string' ? HEX.exec(value.trim()) : null
  return m ? { hex: m[1]!.toUpperCase() } : { error: `${field} must be "#RRGGBB" or null` }
}

/** Validate an insert_text_box call and build the anchored paragraph + its display model. */
export function textBoxNode(
  input: Record<string, unknown>,
): { node: JSONContent; widthPx: number; heightPx: number } | { error: string } {
  const text = typeof input.text === 'string' ? input.text : ''
  if (!text.trim()) return { error: 'text must not be empty' }
  const widthEmu = parseEmu(input.width, 'pt')
  const heightEmu = parseEmu(input.height, 'pt')
  const xEmu = parseEmu(input.x, 'pt')
  const yEmu = parseEmu(input.y, 'pt')
  if (!widthEmu || !heightEmu || widthEmu <= 0 || heightEmu <= 0)
    return { error: `width and height must be positive lengths: ${LENGTH_DESC}` }
  if (xEmu === undefined || yEmu === undefined) return { error: `x and y must be ${LENGTH_DESC}` }
  const anchor = input.anchor === undefined ? 'paragraph' : input.anchor
  if (anchor !== 'paragraph' && anchor !== 'page')
    return { error: 'anchor must be "paragraph" or "page"' }
  const wrap = input.wrap === undefined ? (anchor === 'page' ? 'none' : 'topAndBottom') : input.wrap
  if (wrap !== 'topAndBottom' && wrap !== 'none')
    return { error: 'wrap must be "topAndBottom" or "none"' }
  const fill = hexOrNull(input.fill, 'fill', 'FFFFFF')
  if ('error' in fill) return fill
  const border = hexOrNull(input.borderColor, 'borderColor', '000000')
  if ('error' in border) return border
  const run: Run = { text: '' }
  if (input.fontSize !== undefined) {
    const pt = parsePoints(input.fontSize)
    if (pt === undefined || pt < MIN_FONT_SIZE_PT || pt > MAX_FONT_SIZE_PT)
      return { error: `fontSize must be ${MIN_FONT_SIZE_PT}-${MAX_FONT_SIZE_PT}pt` }
    run.sizeHalfPoints = Math.round(pt * 2)
  }
  if (input.bold === true) run.bold = true
  if (input.color !== undefined) {
    const m = typeof input.color === 'string' ? HEX.exec(input.color.trim()) : null
    if (!m) return { error: 'color must be "#RRGGBB"' }
    run.color = m[1]!.toUpperCase()
  }
  const align = input.align as 'left' | 'center' | 'right' | 'justify' | undefined
  if (align !== undefined && !['left', 'center', 'right', 'justify'].includes(align))
    return { error: 'align must be left, center, right or justify' }
  const paragraphs = text.split('\n').map((line) => ({
    runs: [{ ...run, text: line }],
    ...(align ? { format: { align } } : {}),
  }))
  const xml = buildAnchoredTextboxParagraphXml({
    anchor,
    xEmu,
    yEmu,
    widthEmu,
    heightEmu,
    paragraphs,
    id: Math.floor(Math.random() * 900000) + 100000,
    fillHex: fill.hex,
    borderHex: border.hex,
    wrap,
  })
  const widthPx = emuToPx(widthEmu)
  const heightPx = emuToPx(heightEmu)
  const display: TextboxDisplay = {
    ...(fill.hex ? { fill: fill.hex } : {}),
    ...(border.hex ? { borderColor: border.hex } : {}),
    widthPx,
    heightPx,
    paras: paragraphs.map((p) => ({ runs: p.runs, ...(align ? { align } : {}) })),
    offsetXEmu: xEmu,
    offsetYEmu: yEmu,
    ...(wrap === 'none'
      ? { floating: true }
      : { bandTopPx: emuToPx(yEmu), bandBottomPx: emuToPx(yEmu) + heightPx }),
    ...(anchor === 'page' ? { pagePinned: true, floating: true } : {}),
  }
  return {
    node: {
      type: 'docProtected',
      attrs: {
        docxIndex: null,
        blockType: 'passthrough',
        label: 'Text box',
        previewText: text.replace(/\s+/g, ' ').trim(),
        genXml: xml,
        textboxes: [display],
      },
    },
    widthPx,
    heightPx,
  }
}
