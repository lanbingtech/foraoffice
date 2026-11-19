/** Serialized into the host page; measures source-block visibility, not raster presentation. */
export function observeFirstVisibleSource({
  head,
  newerThan,
}: {
  head: string
  newerThan: number
}) {
  const activity = (
    window as Window & {
      __docsLayoutActivity?: {
        snapshot(): { version: number; generation: number }
      }
    }
  ).__docsLayoutActivity?.snapshot()
  const editor = document.querySelector<HTMLElement>('.ProseMirror.doc-page')
  const scroller = editor?.closest<HTMLElement>('.editor-scroll')
  if (
    !head ||
    !activity ||
    activity.version !== 1 ||
    activity.generation <= newerThan ||
    !editor ||
    !scroller
  )
    return false
  const pane = scroller.getBoundingClientRect()
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  for (const paragraph of editor.querySelectorAll<HTMLElement>('p,.doc-textbox-stray')) {
    if (
      paragraph.closest('.page-gap,.page-repeat-header,.doc-textbox') ||
      !paragraph.textContent?.replace(/\s+/g, '').includes(head)
    )
      continue
    const rect = paragraph.getBoundingClientRect()
    if (
      getComputedStyle(paragraph).visibility !== 'visible' ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      Math.min(rect.right, pane.right, viewport.right) <=
        Math.max(rect.left, pane.left, viewport.left) ||
      Math.min(rect.bottom, pane.bottom, viewport.bottom) <=
        Math.max(rect.top, pane.top, viewport.top)
    )
      continue
    const copy = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
    return {
      observation: 'source-block-geometry',
      sourceRect: copy(rect),
      pane: copy(pane),
      viewport: { width: innerWidth, height: innerHeight },
      scrollTop: scroller.scrollTop,
      scrollLeft: scroller.scrollLeft,
      generation: activity.generation,
    }
  }
  return false
}
