import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { PageCut } from '../pagination-cuts'
import type { PmNode as DocumentJson } from './convert'
import type { PageLayout } from './goto'
import { pagePositions } from './goto'
import { topLevelDomRanges } from './top-level-pos'
import {
  readViewportDecorations,
  viewDecorationWindow,
  type ViewportDecorations,
} from './viewport-decorations'
import { createViewportEditing } from './viewport-editing'
import {
  boxInCanvas,
  intersectsViewport,
  measurePictureFragments,
  type LayoutBox,
  type PictureFragment,
  type ViewportBounds,
} from './viewport-fragments'

interface PositionedBlock {
  from: number
  to: number
  box: LayoutBox
  pictures?: PictureFragment[]
  hidden?: boolean
  tocLeaders?: readonly (number | null)[]
}

interface MeasuredBlock {
  placement: PositionedBlock
  through: number
  ink?: LayoutBox
}

export interface ViewportGeometry {
  canvas: LayoutBox
  blocks: MeasuredBlock[]
  empty?: Record<number, PositionedBlock>
  decorations?: ViewportDecorations
}

export interface ViewportContent {
  canvas: LayoutBox
  blocks: PositionedBlock[]
  decorations?: ViewportDecorations
  model?: {
    document: DocumentJson
    from: number
    to: number
  }
}

/** A source position and the visible range's origin in canvas coordinates. */
export interface ViewportReveal {
  position: number
  top: number
}

/** A view-local handle. Only the DOM-free results cross the renderer boundary. */
export interface ViewportLayout {
  document: PmNode
  pages: readonly PageCut[]
  pageStarts(): Array<number | null> | undefined
  geometry(): ViewportGeometry | undefined
  read(viewport: ViewportBounds): ViewportContent | undefined
  /** Locate a point. The owner chooses the appropriate position for its selection type. */
  reveal(
    position: number,
    height: number,
  ): { content: ViewportContent; reveal: ViewportReveal } | undefined
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
    const { placement, ink = placement.box } = geometry.blocks[i]
    if (ink.top >= viewport.bottom) break
    if (!intersectsViewport(ink, viewport)) continue
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

export function viewportLayout(view: EditorView, layout: PageLayout): ViewportLayout {
  const document = view.state.doc
  const live = () => !view.isDestroyed && view.state.doc === document
  let geometry: ViewportGeometry | undefined
  let starts: Array<number | null> | undefined
  const measure = (): ViewportGeometry => {
    const root = view.dom.getBoundingClientRect()
    const scale = view.dom.currentCSSZoom || 1
    const blocks: MeasuredBlock[] = []
    const empty: Record<number, PositionedBlock> = {}
    for (const { dom, node, from, to } of topLevelDomRanges(view)) {
      if (!(dom instanceof HTMLElement) || dom.parentElement !== view.dom) continue
      const box = boxInCanvas(dom.getBoundingClientRect(), root, scale)
      const pictures = node && measurePictureFragments(view, node, from, root, scale)
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
      blocks.push({ placement, through: coverage.top + coverage.height, ink })
      if (hidden) empty[from] = placement
    }
    blocks.sort((a, b) => (a.ink ?? a.placement.box).top - (b.ink ?? b.placement.box).top)
    for (let i = 1; i < blocks.length; i++)
      blocks[i].through = Math.max(blocks[i].through, blocks[i - 1].through)
    return {
      canvas: boxInCanvas(root, root, scale),
      blocks,
      empty,
      decorations: readViewportDecorations(view),
    }
  }

  return {
    document,
    pages: layout.cuts,
    pageStarts() {
      if (live()) return (starts ??= pagePositions(view, layout))
    },
    geometry() {
      if (live()) return (geometry ??= measure())
    },
    read(viewport) {
      if (!live()) return
      return viewportContent((geometry ??= measure()), viewport, document)
    },
    reveal(position, height) {
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
      try {
        const root = view.dom.getBoundingClientRect()
        caretTop = (view.coordsAtPos(position).top - root.top) / (view.dom.currentCSSZoom || 1)
      } catch {
        return
      }
      if (!Number.isFinite(caretTop) || caretTop < 0 || caretTop > measured.canvas.height) return
      const maxTop = Math.max(0, measured.canvas.height - height)
      const top = Math.min(maxTop, Math.max(0, caretTop - height * 0.3))
      const content = viewportContent(measured, { top, bottom: top + height }, document)
      if (!content.model || position < content.model.from || position > content.model.to) return
      return { content, reveal: { position, top } }
    },
  }
}
