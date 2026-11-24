import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { PageCut } from '../pagination-cuts'
import type { PmNode as DocumentJson } from './convert'
import type { PageLayout } from './goto'
import { pagePositions } from './goto'
import { topLevelDomRanges } from './top-level-pos'
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
}

interface MeasuredBlock {
  placement: PositionedBlock
  node?: PmNode
  through: number
}

export interface ViewportContent {
  canvas: LayoutBox
  blocks: PositionedBlock[]
  model?: {
    document: DocumentJson
    from: number
    to: number
  }
}

/** A view-local handle. Only the DOM-free results cross the renderer boundary. */
export interface ViewportLayout {
  document: PmNode
  pages: readonly PageCut[]
  pageStarts(): Array<number | null> | undefined
  read(viewport: ViewportBounds): ViewportContent | undefined
}

export function viewportLayout(view: EditorView, layout: PageLayout): ViewportLayout {
  const document = view.state.doc
  const live = () => !view.isDestroyed && view.state.doc === document
  let geometry: ReturnType<typeof measure> | undefined
  let starts: Array<number | null> | undefined
  const measure = () => {
    const root = view.dom.getBoundingClientRect()
    const scale = view.dom.currentCSSZoom || 1
    const blocks: MeasuredBlock[] = []
    for (const { dom, node, from, to } of topLevelDomRanges(view)) {
      if (!(dom instanceof HTMLElement) || dom.parentElement !== view.dom) continue
      const box = boxInCanvas(dom.getBoundingClientRect(), root, scale)
      blocks.push({ placement: { from, to, box }, node, through: box.top + box.height })
    }
    blocks.sort((a, b) => a.placement.box.top - b.placement.box.top)
    for (let i = 1; i < blocks.length; i++)
      blocks[i].through = Math.max(blocks[i].through, blocks[i - 1].through)
    return { canvas: boxInCanvas(root, root, scale), blocks, scale }
  }

  const pictures = new Map<number, PictureFragment[] | undefined>()
  return {
    document,
    pages: layout.cuts,
    pageStarts() {
      if (live()) return (starts ??= pagePositions(view, layout))
    },
    read(viewport) {
      if (!live()) return
      const measured = (geometry ??= measure())
      const blocks: PositionedBlock[] = []
      let root: DOMRect | undefined
      let low = 0
      let high = measured.blocks.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (measured.blocks[middle].through > viewport.top) high = middle
        else low = middle + 1
      }
      for (let i = low; i < measured.blocks.length; i++) {
        const { placement, node } = measured.blocks[i]
        if (placement.box.top >= viewport.bottom) break
        if (!intersectsViewport(placement.box, viewport)) continue
        if (!pictures.has(placement.from)) {
          root ??= view.dom.getBoundingClientRect()
          pictures.set(
            placement.from,
            node && measurePictureFragments(view, node, placement.from, root, measured.scale),
          )
        }
        const fragments = pictures
          .get(placement.from)
          ?.filter((fragment) => intersectsViewport(fragment.box, viewport))
        // The canvas still spans this page gap. A picture-only block has no
        // editable content here until one of its placed pictures is in view.
        if (fragments?.length === 0) continue
        blocks.push({
          ...placement,
          ...(fragments ? { pictures: fragments } : {}),
        })
      }
      blocks.sort((a, b) => a.from - b.from)
      const editing = createViewportEditing(document, blocks)
      return {
        canvas: measured.canvas,
        blocks,
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
    },
  }
}
