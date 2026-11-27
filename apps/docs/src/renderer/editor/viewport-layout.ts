import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { PageCut } from '../pagination-cuts'
import { hasNonLocalFlow } from '../pagination-measure'
import { sliceStartsVisiblePage } from '../pagination-slices'
import type { PmNode as DocumentJson } from './convert'
import type { PageLayout } from './goto'
import { pagePositions } from './goto'
import { pageFramesFromGaps, pageGapPositions, type PageFrame } from './pagination-gaps'
import { topLevelDomRanges } from './top-level-pos'
import {
  readViewportDecorations,
  viewDecorationWindow,
  type ViewportDecorations,
} from './viewport-decorations'
import { createViewportEditing, type ViewportModelBlock } from './viewport-editing'
import {
  boxInCanvas,
  intersectsViewport,
  measureParagraphFragments,
  measurePictureFragments,
  type LayoutBox,
  type ParagraphFragment,
  type PictureFragment,
  type ViewportBounds,
} from './viewport-fragments'
import { tablePaintReader, type TablePaint } from './viewport-table-paint'

interface PositionedBlock extends ViewportModelBlock {
  box: LayoutBox
  tableCellTypography?: string
  pictures?: PictureFragment[]
  hidden?: boolean
  tocLeaders?: readonly (number | null)[]
}

interface MeasuredBlock {
  placement: PositionedBlock
  through: number
  ink?: LayoutBox
  fragments?: ParagraphFragment[]
}

export interface ViewportGeometry {
  canvas: LayoutBox
  blocks: MeasuredBlock[]
  empty?: Record<number, PositionedBlock>
  decorations?: ViewportDecorations
}

interface ViewportWindow {
  canvas: LayoutBox
  blocks: PositionedBlock[]
  decorations?: ViewportDecorations
  tablePaint?: TablePaint
  model?: {
    document: DocumentJson
    from: number
    to: number
  }
}

export interface ViewportContent extends ViewportWindow {
  /** The surrounding window from the same layout as an active cell paragraph. */
  surrounding?: ViewportWindow
}

/** A source position and the visible range's origin in canvas coordinates. */
export interface ViewportReveal {
  position: number
  top: number
}

/** A physical page in canvas coordinates, linked to its opening pagination cut. */
export interface ViewportPageFrame extends LayoutBox {
  cutIndex: number
  /** Blank pages can have no navigable source position. */
  sourceStart: number | null
}

export type ViewportRevealScope = 'table-cell' | 'table-window'

/** A view-local handle. Only the DOM-free results cross the renderer boundary. */
export interface ViewportLayout {
  document: PmNode
  pages: readonly PageCut[]
  pageStarts(): Array<number | null> | undefined
  pageFrames(): readonly ViewportPageFrame[] | undefined
  geometry(): ViewportGeometry | undefined
  read(viewport: ViewportBounds): ViewportContent | undefined
  /** Locate a point. The owner chooses the appropriate position for its selection type. */
  reveal(
    position: number,
    height: number,
    scope?: ViewportRevealScope,
  ): { content: ViewportContent; reveal: ViewportReveal } | undefined
}

const cellTypography = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-indent',
  'text-transform',
  'white-space',
  'word-break',
  'overflow-wrap',
  'direction',
  'color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
]

/** An active editor may edit a cell's paragraph without mounting its table.
 * Only accept paragraphs whose complete text layout exists in the measured view. */
function readTableCell(
  view: EditorView,
  document: PmNode,
  position: number,
  geometry: ViewportGeometry,
  root: DOMRectReadOnly,
  scale: number,
): ViewportContent | undefined {
  const caret = document.resolve(position)
  if (caret.depth !== 4 || caret.parent.type.name !== 'docParagraph') return
  const paragraphPosition = caret.before()
  const element = view.nodeDOM(paragraphPosition)
  if (
    !(element instanceof HTMLElement) ||
    element.tagName !== 'P' ||
    !element.isConnected ||
    element.closest('.cell-clip, td[data-cell-clip], th[data-cell-clip]') ||
    element.querySelector('.page-gap, .page-gap-cut, .doc-page-br')
  )
    return
  const cell = caret.node(3)
  if (cell.attrs.gridGap || cell.attrs.mergeGap) return
  const style = getComputedStyle(element)
  if (style.writingMode !== 'horizontal-tb' || style.visibility !== 'visible') return
  const box = boxInCanvas(element.getBoundingClientRect(), root, scale)
  if (!(box.width > 0) || !(box.height > 0)) return
  const block: PositionedBlock = {
    from: caret.before(1),
    to: caret.after(1),
    box,
    tableCellText: {
      position: paragraphPosition,
      from: caret.start(),
      to: caret.end(),
    },
    tableCellTypography: cellTypography
      .map((property) => `${property}:${style.getPropertyValue(property)}`)
      .join(';'),
  }
  const editing = createViewportEditing(document, [block])
  if (!editing) return
  return {
    canvas: geometry.canvas,
    blocks: [block],
    decorations: viewDecorationWindow(geometry.decorations ?? [], paragraphPosition, caret.after()),
    model: {
      document: editing.doc.toJSON() as DocumentJson,
      from: editing.sourceRange.from,
      to: editing.sourceRange.to,
    },
  }
}

/** A hidden model atom can sit between visible blocks but have no ink in the
 * window. Its document positions still belong to the editable range. */
function includeEmptyBlocks(
  geometry: ViewportGeometry,
  visible: PositionedBlock[],
): PositionedBlock[] {
  if (!geometry.empty) return visible
  let result: PositionedBlock[] | undefined
  for (let i = 1; i < visible.length; i++) {
    let from = visible[i - 1].to
    const next = visible[i]
    if (from === next.from) {
      result?.push(next)
      continue
    }
    result ??= visible.slice(0, i)
    while (from < next.from) {
      const gap = geometry.empty[from]
      if (!gap || gap.to <= from || gap.to > next.from) break
      result.push({ ...gap, hidden: true })
      from = gap.to
    }
    result.push(next)
  }
  return result ?? visible
}

/** Input to the scroll path is immutable, already in canvas coordinates, and
 * small enough to keep in the foreground. No DOM reads or renderer round trip. */
export function viewportContent(
  geometry: ViewportGeometry,
  viewport: ViewportBounds,
  document?: PmNode,
): ViewportContent {
  const visible: PositionedBlock[] = []
  let low = 0
  let high = geometry.blocks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (geometry.blocks[middle].through > viewport.top) high = middle
    else low = middle + 1
  }
  for (let i = low; i < geometry.blocks.length; i++) {
    const { placement, ink = placement.box, fragments } = geometry.blocks[i]
    if (ink.top >= viewport.bottom) break
    if (!intersectsViewport(ink, viewport)) continue
    if (fragments) {
      let start = 0
      let end = fragments.length
      while (start < end) {
        const middle = (start + end) >>> 1
        const { top, height } = fragments[middle].box
        if (top + height > viewport.top) end = middle
        else start = middle + 1
      }
      const first = fragments[start]
      if (!first || first.box.top >= viewport.bottom) continue
      while (end + 1 < fragments.length && fragments[end + 1].box.top < viewport.bottom) end++
      if (start > 0 || end < fragments.length - 1) {
        const last = fragments[end]
        visible.push({
          ...placement,
          box: { ...placement.box, top: first.top, height: last.bottom - first.top },
          paragraph: { from: first.from, to: last.to },
        })
        continue
      }
    }
    const pictures = placement.pictures?.filter((fragment) =>
      intersectsViewport(fragment.box, viewport),
    )
    // A visible page gap contains no editable picture.
    if (pictures?.length === 0) continue
    visible.push(pictures ? { ...placement, pictures } : placement)
  }
  visible.sort((a, b) => a.from - b.from)
  const blocks = includeEmptyBlocks(geometry, visible)
  const editing = document && createViewportEditing(document, blocks)
  const decorations =
    geometry.decorations && blocks.length > 0
      ? viewDecorationWindow(geometry.decorations, blocks[0].from, blocks[blocks.length - 1].to)
      : undefined
  return {
    canvas: geometry.canvas,
    blocks,
    ...(decorations?.length ? { decorations } : {}),
    ...(editing
      ? {
          model: {
            document: editing.doc.toJSON() as DocumentJson,
            from: editing.sourceRange.from,
            to: editing.sourceRange.to,
          },
        }
      : {}),
  }
}

export function viewportLayout(
  view: EditorView,
  layout: PageLayout,
  firstPage?: Pick<PageFrame, 'left' | 'width'>,
): ViewportLayout {
  const document = view.state.doc
  const paintTable = tablePaintReader(view)
  const live = () => !view.isDestroyed && view.state.doc === document
  let geometry: ViewportGeometry | undefined
  let starts: Array<number | null> | undefined
  let frames: ViewportPageFrame[] | undefined
  const readStarts = () => (starts ??= pagePositions(view, layout))
  const measure = (): ViewportGeometry => {
    const root = view.dom.getBoundingClientRect()
    const scale = view.dom.currentCSSZoom || 1
    const decorations = readViewportDecorations(view)
    const candidates = new Map<HTMLElement, number[] | null>()
    const anchors = pageGapPositions(view.state)
    layout.cuts.forEach((cut, index) => {
      if (cut.lead.kind !== 'line') return
      const block = layout.blocks[cut.lead.block]
      const element = block?.el
      if (!element) return
      const position = anchors.get(index)
      if (
        position === undefined ||
        block.breakBefore ||
        cut.blank ||
        cut.regions?.length ||
        cut.gap?.kind !== 'inline' ||
        cut.gap.pullUpPx !== 0 ||
        !Number.isFinite(cut.lead.lineOffset)
      ) {
        candidates.set(element, null)
        return
      }
      const starts = candidates.get(element)
      if (starts) starts.push(position)
      else if (starts === undefined) candidates.set(element, [position])
    })
    if (
      candidates.size &&
      (layout.blocks.some((block) => block.floated) || hasNonLocalFlow(view.dom))
    )
      candidates.clear()
    const blocks: MeasuredBlock[] = []
    const empty: Record<number, PositionedBlock> = {}
    for (const { dom, node, from, to } of topLevelDomRanges(view)) {
      if (!(dom instanceof HTMLElement) || dom.parentElement !== view.dom) continue
      const box = boxInCanvas(dom.getBoundingClientRect(), root, scale)
      const pictures = node && measurePictureFragments(view, node, from, root, scale)
      const positions = candidates.get(dom)
      // Keep the same inline widgets in the projected paragraph, including at
      // its local start and end. Other decorations need the full paragraph.
      const spans = positions && viewDecorationWindow(decorations, from, to)
      const fragments =
        node &&
        positions &&
        spans &&
        spans.length === positions.length &&
        spans.every(
          (span, index) =>
            'flowGap' in span && span.flowGap.kind === 'inline' && span.from === positions[index],
        )
          ? measureParagraphFragments(view, node, dom, from, positions, box, root, scale)
          : undefined
      // Out-of-flow figures can paint across pages from a zero-height wrapper.
      // Keep its placement at the anchor but index the painted descendants.
      let ink: LayoutBox | undefined
      if (box.height === 0 && dom.firstChild) {
        const range = dom.ownerDocument.createRange()
        range.selectNodeContents(dom)
        const bounds = range.getBoundingClientRect()
        if (bounds.height > 0 && bounds.width > 0) ink = boxInCanvas(bounds, root, scale)
      }
      const hidden = box.height === 0 && !ink
      const leaders = Array.from(dom.querySelectorAll<HTMLElement>('.doc-toc-tail'), (tail) => {
        const value = Number.parseFloat(tail.style.getPropertyValue('--doc-toc-gap'))
        return Number.isFinite(value) && value >= 0 ? value : null
      })
      const placement: PositionedBlock = {
        from,
        to,
        box,
        pictures,
        hidden,
        ...(leaders.some((value) => value !== null) ? { tocLeaders: leaders } : {}),
      }
      const coverage = ink ?? box
      blocks.push({ placement, through: coverage.top + coverage.height, ink, fragments })
      if (hidden) empty[from] = placement
    }
    blocks.sort((a, b) => (a.ink ?? a.placement.box).top - (b.ink ?? b.placement.box).top)
    for (let i = 1; i < blocks.length; i++)
      blocks[i].through = Math.max(blocks[i].through, blocks[i - 1].through)
    return {
      canvas: boxInCanvas(root, root, scale),
      blocks,
      empty,
      decorations,
    }
  }

  return {
    document,
    pages: layout.cuts,
    pageStarts() {
      if (live()) return readStarts()
    },
    pageFrames() {
      if (!live()) return
      if (frames) return frames
      const wrap = view.dom.closest<HTMLElement>('.page-wrap')
      if (!wrap) return
      const cutIndices = layout.slices.flatMap((slice, i) =>
        sliceStartsVisiblePage(slice, layout.slices[i - 1]) ? [i] : [],
      )
      // A missing gap leaves no physical frame boundary even if pagination
      // has a logical cut. Avoid assigning that frame to the next page.
      if (cutIndices.length === 0 || cutIndices.some((i) => i > 0 && !layout.cuts[i]?.gap)) return
      const scale = view.dom.currentCSSZoom || 1
      const measured = pageFramesFromGaps(wrap, scale, firstPage, layout.cuts)
      if (measured.length !== cutIndices.length) return
      const origin = boxInCanvas(
        wrap.getBoundingClientRect(),
        view.dom.getBoundingClientRect(),
        scale,
      )
      const positions = readStarts()
      const next = measured.map(({ left, top, bottom, width }, index) => ({
        cutIndex: cutIndices[index],
        sourceStart: positions[index],
        left: left + origin.left,
        top: top + origin.top,
        width,
        height: bottom - top,
      }))
      if (
        next.some(
          ({ left, top, width, height }) =>
            !Number.isFinite(left) ||
            !Number.isFinite(top) ||
            !Number.isFinite(width) ||
            !Number.isFinite(height) ||
            width <= 0 ||
            height <= 0,
        )
      )
        return
      return (frames = next)
    },
    geometry() {
      if (live()) return (geometry ??= measure())
    },
    read(viewport) {
      if (!live()) return
      return viewportContent((geometry ??= measure()), viewport, document)
    },
    reveal(position, height, scope) {
      if (
        !live() ||
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > document.content.size ||
        !Number.isFinite(height) ||
        height <= 0
      )
        return
      const measured = (geometry ??= measure())
      let caretTop: number
      const root = view.dom.getBoundingClientRect()
      const scale = view.dom.currentCSSZoom || 1
      try {
        caretTop = (view.coordsAtPos(position).top - root.top) / scale
      } catch {
        return
      }
      if (!Number.isFinite(caretTop) || caretTop < 0 || caretTop > measured.canvas.height) return
      const maxTop = Math.max(0, measured.canvas.height - height)
      const top = Math.min(maxTop, Math.max(0, caretTop - height * 0.3))
      const bounds = { top, bottom: top + height }
      const content = scope
        ? readTableCell(view, document, position, measured, root, scale)
        : viewportContent(measured, bounds, document)
      if (!content?.model || position < content.model.from || position > content.model.to) return
      if (scope === 'table-window') {
        const surrounding = viewportContent(measured, bounds)
        // This scope requires a bounded containing table. An unavailable
        // scene leaves the caller's ordinary document surface in place.
        if (
          surrounding.blocks.length !== 1 ||
          surrounding.blocks[0].from !== content.blocks[0].from
        )
          return
        const table = paintTable(content.blocks[0].from, bounds, root, scale)
        if (!table) return
        surrounding.tablePaint = table
        content.surrounding = surrounding
      }
      return { content, reveal: { position, top } }
    },
  }
}
