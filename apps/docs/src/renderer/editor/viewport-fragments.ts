import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export interface ViewportBounds {
  top: number
  bottom: number
}

export interface LayoutBox {
  left: number
  top: number
  width: number
  height: number
}

export interface PictureFragment {
  /** The original document position, including the paragraph's opening token. */
  from: number
  to: number
  box: LayoutBox
}

export function boxInCanvas(
  box: DOMRectReadOnly,
  canvas: DOMRectReadOnly,
  scale: number,
): LayoutBox {
  return {
    left: (box.left - canvas.left) / scale,
    top: (box.top - canvas.top) / scale,
    width: box.width / scale,
    height: box.height / scale,
  }
}

export function intersectsViewport(box: LayoutBox, viewport: ViewportBounds): boolean {
  return box.top < viewport.bottom && box.top + box.height > viewport.top
}

/** Read the placed images of an independent picture-only paragraph. Other
 * paragraphs keep their existing layout dependencies, including wrapping. */
export function measurePictureFragments(
  view: Pick<EditorView, 'nodeDOM'>,
  paragraph: PmNode,
  from: number,
  canvas: DOMRectReadOnly,
  scale: number,
): PictureFragment[] | undefined {
  if (paragraph.type.name !== 'docParagraph' || paragraph.childCount < 2) return
  const fragments: PictureFragment[] = []
  for (let index = 0, offset = from + 1; index < paragraph.childCount; index++) {
    const child = paragraph.child(index)
    if (child.type.name !== 'docInlineImage' || child.attrs.wrap || child.attrs.rule) return
    const element = view.nodeDOM(offset)
    if (!(element instanceof HTMLElement) || !element.classList.contains('doc-inline-pic')) return
    const box = boxInCanvas(element.getBoundingClientRect(), canvas, scale)
    if (!(box.width > 0) || !(box.height > 0)) return
    fragments.push({ from: offset, to: offset + child.nodeSize, box })
    offset += child.nodeSize
  }
  return fragments
}
