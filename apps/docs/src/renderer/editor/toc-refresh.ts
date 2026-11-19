import type { FieldDisplay } from '@genoffice/docx-engine'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

import type { HeadingRef } from './headings'

/**
 * Backfill TOC page caches from measured bookmarks and generated heading entries.
 *
 * `displays` is aligned with `headings` (document order): one formatted page
 * string per heading, or undefined when the heading was not measured
 * (unmeasured entries keep their tocLine untouched instead of shifting later
 * pages up). The caller formats via the owning section's pgNumType, so
 * Roman/letter/dashed numbers survive the refresh. Duplicate titles keep
 * their own entries — the Nth tocLine with a title takes the Nth same-titled
 * heading's page (extras reuse the last one, matching a stale TOC with more
 * lines than headings).
 *
 * An imported PAGEREF keeps its cache when its exact target cannot be measured.
 * Returns true when `tr` gained at least one node update.
 */
export function applyTocPageDisplays(
  doc: PmNode,
  tr: Transaction,
  headings: HeadingRef[],
  displays: Array<string | undefined>,
  pageTextOfBookmark?: (bookmark: string) => string | undefined,
): boolean {
  const pagesOfTitle = new Map<string, Array<string | undefined>>()
  headings.forEach((h, i) => {
    const key = h.text.trim()
    const list = pagesOfTitle.get(key)
    if (list) list.push(displays[i])
    else pagesOfTitle.set(key, [displays[i]])
  })
  let changed = false
  const seen = new Map<string, number>()
  doc.forEach((node, offset) => {
    if (node.type.name !== 'docProtected') return
    const field = node.attrs.fieldDisplay as FieldDisplay | null
    if (field?.kind !== 'tocLine') return
    let right: string | undefined
    if (field.pageRefBookmark !== undefined) {
      if (field.pageRefBookmark !== null) right = pageTextOfBookmark?.(field.pageRefBookmark)
    } else {
      const key = (field.left ?? '').trim()
      const list = pagesOfTitle.get(key)
      if (!list) return
      const nth = seen.get(key) ?? 0
      seen.set(key, nth + 1)
      right = list[Math.min(nth, list.length - 1)]
    }
    if (right === undefined || (field.right ?? '') === right) return
    tr.setNodeMarkup(offset, undefined, {
      ...node.attrs,
      fieldDisplay: { ...field, right },
    })
    changed = true
  })
  return changed
}

/**
 * DOM-only TOC page refresh from the live layout. Until the document is edited
 * (`dirty`) a stored field result stays, as in Word; empty ones take the live page.
 */
export function backfillTocPageDom(
  tocLines: Iterable<HTMLElement>,
  pageTextOf: (bookmark: string) => string | undefined,
  dirty: boolean,
  archivedPageRefs?: ReadonlyMap<number, string | null>,
): number {
  let n = 0
  for (const el of tocLines) {
    const pageEl = el.querySelector('.doc-toc-page')
    if (!pageEl) continue
    const live = el.hasAttribute('data-toc-live')
    if (!dirty && !live && (pageEl.textContent ?? '').trim() !== '') continue
    const index = el.closest<HTMLElement>('.doc-protected[data-idx]')?.dataset.idx
    const ref = index ? archivedPageRefs?.get(Number(index)) : undefined
    const hyperlink = el.getAttribute('data-toc-anchor')
    // Imported references own their page display; a hyperlink remains a click target.
    const bookmark = ref === undefined ? (hyperlink?.startsWith('_') ? hyperlink : null) : ref
    if (!bookmark) continue
    const text = pageTextOf(bookmark)
    if (text === undefined) continue
    // a page we filled ourselves keeps following the layout on later passes
    if (!dirty && !live) el.setAttribute('data-toc-live', '')
    if (pageEl.textContent === text) continue
    pageEl.textContent = text
    n++
  }
  return n
}
