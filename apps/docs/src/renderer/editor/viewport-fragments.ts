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

export interface ParagraphFragment {
  from: number
  to: number
  /** Text flow between these two mounted page turns. */
  box: LayoutBox
  /** Retain the bordering turns in the flow to preserve both edge lines. */
  top: number
  bottom: number
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

/** A plain text continuation can restart the browser's inline layout at a
 * real page turn. Mixed inline DOM and context-dependent paragraph layout
 * still need the original block. */
export function measureParagraphFragments(
  view: Pick<EditorView, 'posAtDOM'>,
  paragraph: PmNode,
  dom: HTMLElement,
  from: number,
  starts: readonly number[],
  box: LayoutBox,
  canvas: DOMRectReadOnly,
  scale: number,
): ParagraphFragment[] | undefined {
  const text = paragraph.firstChild?.text
  if (
    paragraph.type.name !== 'docParagraph' ||
    paragraph.childCount !== 1 ||
    paragraph.firstChild?.marks.length ||
    !text ||
    /[^ -~]/.test(text) ||
    dom.tagName !== 'P' ||
    dom.closest('.show-marks') ||
    dom.classList.contains('doc-col-block') ||
    !(box.width > 0) ||
    !(box.height > 0)
  )
    return

  const style = getComputedStyle(dom)
  if (
    style.direction !== 'ltr' ||
    style.writingMode !== 'horizontal-tb' ||
    (style.textAlign !== 'start' && style.textAlign !== 'left' && style.textAlign !== 'justify') ||
    style.textAlignLast !== 'auto' ||
    style.whiteSpace !== 'pre-wrap' ||
    style.getPropertyValue('text-wrap-style') !== 'auto' ||
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    style.backgroundImage !== 'none' ||
    [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].some(
      (value) => Number.parseFloat(value) !== 0,
    )
  )
    return

  const fragments: ParagraphFragment[] = []
  let modelStart = from + 1
  let inkTop = box.top
  let top = box.top
  const to = modelStart + text.length
  const bottom = box.top + box.height
  for (const child of dom.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) continue
    if (!(child instanceof HTMLElement) || !child.matches('.page-gap-inline:not(.page-gap-carry)'))
      return
    const position = starts[fragments.length]
    if (position === undefined || position <= modelStart || position >= to) return
    if (view.posAtDOM(child, 0) !== position) return
    const gap = boxInCanvas(child.getBoundingClientRect(), canvas, scale)
    if (!(gap.top > inkTop) || !(gap.height > 0) || !(gap.top + gap.height < bottom)) return
    fragments.push({
      from: modelStart,
      to: position,
      box: { ...box, top: inkTop, height: gap.top - inkTop },
      top,
      bottom: gap.top + gap.height,
    })
    modelStart = position
    top = gap.top
    inkTop = gap.top + gap.height
  }
  if (fragments.length !== starts.length) return
  fragments.push({
    from: modelStart,
    to,
    box: { ...box, top: inkTop, height: bottom - inkTop },
    top,
    bottom,
  })
  return fragments
}
