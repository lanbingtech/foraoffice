import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PAGE_TURN_SEL } from '../editor/pagination-gaps'
import { pagePaperEdges, pageReaderShadow, type PageCut } from '../pagination-cuts'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useI18n } from '../i18n/locale'
import type { ViewportPage } from '../viewport-page'

/** page paper edges in unzoomed canvas px, measured from the live page gaps */
export interface ThumbPage {
  top: number
  height: number
}

interface ThumbBlock {
  el: HTMLElement
  top: number
  left: number
  width: number
  height: number
}

export interface ThumbSnapshot {
  pageW: number
  pages: ThumbPage[]
  blocks: ThumbBlock[]
  /** the canvas' page-geometry custom properties, so clones lay out like the page */
  vars: string
}

const FALLBACK_PAGE_H = 1056
const THUMB_GUTTER = 12
const THUMB_MAX_W = 200

/**
 * Word's Pages tab reads the printed pages; ours reads the canvas: every non-carry
 * page gap ends one paper and starts the next, so the thumbnails show exactly what
 * the canvas shows (in-table cuts and mid-paragraph breaks included).
 */
export function snapshotPages(
  pm: HTMLElement,
  zoom: number,
  cuts?: readonly PageCut[],
): ThumbSnapshot | null {
  const wrap = pm.closest<HTMLElement>('.page-wrap')
  const docZoom = wrap?.closest<HTMLElement>('.doc-zoom')
  if (!wrap || !docZoom || zoom <= 0) return null
  const wrapRect = wrap.getBoundingClientRect()
  if (wrapRect.width === 0) return null
  const pageW = wrapRect.width / zoom
  const pageH =
    parseFloat(getComputedStyle(docZoom).getPropertyValue('--page-h')) || FALLBACK_PAGE_H
  const pagesOf = (edges: Array<{ top: number; prevBottom: number }>): ThumbPage[] => {
    const starts = [0]
    const ends: number[] = []
    for (const e of edges) {
      ends.push(e.prevBottom)
      starts.push(e.top)
    }
    ends.push(starts[starts.length - 1] + pageH)
    return starts.map((top, i) => ({ top, height: Math.max(1, ends[i] - top) }))
  }
  const fromDom = () =>
    pagesOf(
      [...pm.querySelectorAll<HTMLElement>(PAGE_TURN_SEL)].flatMap((gap) => {
        const r = gap.getBoundingClientRect()
        if (r.height === 0) return []
        const cs = getComputedStyle(gap)
        const mb = parseFloat(cs.getPropertyValue('--gap-mb')) || 0
        const mt = parseFloat(cs.getPropertyValue('--gap-mt')) || 0
        return [
          {
            prevBottom: (r.top - wrapRect.top) / zoom + mb,
            top: (r.bottom - wrapRect.top) / zoom - mt,
          },
        ]
      }),
    )
  let pages: ThumbPage[]
  if (cuts) {
    const pmOff = (pm.getBoundingClientRect().top - wrapRect.top) / zoom
    const firstMt = parseFloat(getComputedStyle(pm).paddingTop) || 0
    pages = pagesOf(
      pagePaperEdges(cuts, firstMt)
        .filter((e) => e.gap.heightPx > 0)
        .map((e) => ({ top: pmOff + e.top, prevBottom: pmOff + e.prevBottom })),
    )
    if (pageReaderShadow.enabled) {
      const dom = fromDom()
      const off =
        dom.length !== pages.length
          ? `count ${dom.length} vs ${pages.length}`
          : dom
              .map((p, i) => (Math.abs(p.top - pages[i].top) > 1 ? `page ${i + 1}` : ''))
              .find(Boolean)
      if (off) pageReaderShadow.report('thumbPages', dom.length, pages.length, off)
    }
  } else pages = fromDom()
  const blocks: ThumbBlock[] = []
  for (const el of Array.from(pm.children) as HTMLElement[]) {
    const r = el.getBoundingClientRect()
    if (r.height === 0 || r.width === 0) continue
    blocks.push({
      el,
      top: (r.top - wrapRect.top) / zoom,
      left: (r.left - wrapRect.left) / zoom,
      width: r.width / zoom,
      height: r.height / zoom,
    })
  }
  const vars = (docZoom.getAttribute('style') ?? '')
    .split(';')
    .filter((d) => d.trim().startsWith('--'))
    .join(';')
  return { pageW, pages, blocks, vars }
}

/** index of the page whose paper contains canvas y */
export function pageIndexAtY(pages: ThumbPage[], y: number): number {
  let idx = 0
  for (let i = 1; i < pages.length; i++) if (pages[i].top <= y) idx = i
  return idx
}

/** Group at snapshot time so a newly visible thumbnail never searches the whole canvas. */
function blocksByPage(snap: ThumbSnapshot): ThumbBlock[][] {
  const result = snap.pages.map((): ThumbBlock[] => [])
  const pages = snap.pages.map((page, index) => ({ ...page, index })).sort((a, b) => a.top - b.top)
  let end = -Infinity
  const maxEnds = pages.map((page) => (end = Math.max(end, page.top + page.height)))
  for (const block of snap.blocks) {
    let lo = 0
    let hi = pages.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (maxEnds[mid] <= block.top) lo = mid + 1
      else hi = mid
    }
    const bottom = block.top + block.height
    for (let i = lo; i < pages.length && pages[i].top < bottom; i++) {
      const page = pages[i]
      if (page.top + page.height > block.top) result[page.index].push(block)
    }
  }
  return result
}

function Thumb({
  snap,
  index,
  scale,
  blocks,
  hit,
  onPick,
}: {
  snap: ThumbSnapshot
  index: number
  scale: number
  blocks: ThumbBlock[]
  hit: boolean
  onPick: (index: number) => void
}) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const drawRef = useRef<(root: HTMLDivElement) => void>(() => {})
  const transformRef = useRef('')
  const page = snap.pages[index]

  useLayoutEffect(() => {
    transformRef.current = `scale(${scale})`
    if (previewRef.current) previewRef.current.style.transform = transformRef.current
  }, [scale])
  useLayoutEffect(() => {
    const drawContents = (root: HTMLDivElement) => {
      const owner = root.ownerDocument
      root.style.cssText = snap.vars
      root.style.width = `${snap.pageW}px`
      root.style.height = `${page.height}px`
      root.style.transform = transformRef.current
      root.replaceChildren()
      for (const b of blocks) {
        const slot = owner.createElement('div')
        slot.className = 'nav-thumb-slot'
        slot.style.top = `${b.top - page.top}px`
        slot.style.left = `${b.left}px`
        slot.style.width = `${b.width}px`
        const clone = b.el.cloneNode(true) as HTMLElement
        // The slot includes the block's margins and transforms.
        clone.style.margin = '0'
        clone.style.transform = 'none'
        clone.removeAttribute('contenteditable')
        slot.appendChild(clone)
        root.appendChild(slot)
      }
    }
    drawRef.current = drawContents
    if (previewRef.current) drawContents(previewRef.current)
  }, [snap, page, blocks])
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const owner = host.ownerDocument
    const removePreview = () => {
      previewRef.current?.remove()
      previewRef.current = null
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.at(-1)?.isIntersecting) {
          removePreview()
          return
        }
        if (previewRef.current) return
        const root = owner.createElement('div')
        root.className = 'nav-thumb-page doc-page ProseMirror'
        root.setAttribute('aria-hidden', 'true')
        drawRef.current(root)
        host.prepend(root)
        previewRef.current = root
      },
      { root: host.closest('.nav-body'), rootMargin: '200px 0px' },
    )
    io.observe(host)
    return () => {
      io.disconnect()
      removePreview()
    }
  }, [])

  return (
    <button
      ref={hostRef}
      type="button"
      className={`nav-thumb${hit ? ' hit' : ''}`}
      style={{ width: snap.pageW * scale, height: page.height * scale }}
      aria-label={t('appNavPage', { n: index + 1 })}
      onClick={() => onPick(index)}
    >
      <span className="nav-thumb-num">{index + 1}</span>
    </button>
  )
}

export function NavPageThumbs({
  editor,
  zoom,
  width,
  layoutVersion,
  viewportPage,
  hitPositions,
  cuts,
}: {
  editor: Editor
  zoom: number
  width: number
  /** bumps when the document or its pagination changed */
  layoutVersion: number
  /** the current pass's page cuts (page edges); the gap widgets are the fallback */
  cuts?: () => readonly PageCut[] | undefined
  viewportPage: ViewportPage
  /** search hit positions: when non-null the tab lists only pages with a hit */
  hitPositions: number[] | null
}) {
  const { t } = useI18n()
  const [snap, setSnap] = useState<ThumbSnapshot | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeButtonRef = useRef<Element | undefined>(undefined)
  // pagination lands after the document change: the page-wrap grows or shrinks with its gaps
  const [wrapHeight, setWrapHeight] = useState(0)
  useEffect(() => {
    const wrap = editor.view.dom.closest<HTMLElement>('.page-wrap')
    if (!wrap) return
    const ro = new ResizeObserver(() => setWrapHeight(wrap.offsetHeight))
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [editor])

  useEffect(() => {
    let raf = 0
    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(() => setSnap(snapshotPages(editor.view.dom, zoom, cuts?.())))
    }, 250)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [editor, zoom, layoutVersion, wrapHeight, cuts])

  const hitPages = useMemo(() => {
    if (!snap || !hitPositions) return null
    const wrap = editor.view.dom.closest<HTMLElement>('.page-wrap')
    if (!wrap) return null
    const wrapTop = wrap.getBoundingClientRect().top
    const set = new Set<number>()
    for (const pos of hitPositions) {
      try {
        const y = (editor.view.coordsAtPos(pos).top - wrapTop) / zoom
        set.add(pageIndexAtY(snap.pages, y))
      } catch {
        /* position no longer in the document */
      }
    }
    return set
  }, [snap, hitPositions, editor, zoom])

  const groupedBlocks = useMemo(() => (snap ? blocksByPage(snap) : []), [snap])
  const indices = useMemo(
    () => snap?.pages.map((_, i) => i).filter((i) => !hitPages || hitPages.has(i)) ?? [],
    [snap, hitPages],
  )
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      activeButtonRef.current = undefined
      return
    }
    const buttons = new Map(
      Array.from(list.children, (button, index) => [indices[index] + 1, button] as const),
    )
    return viewportPage.observe(({ current }) => {
      const next = buttons.get(current)
      const previous = activeButtonRef.current
      const changed = previous !== next
      if (changed) {
        previous?.classList.remove('on')
        previous?.removeAttribute('aria-current')
        activeButtonRef.current = next
      }
      if (!next) return
      // React can update the search-hit class on a list refresh.
      if (!next.classList.contains('on')) next.classList.add('on')
      if (changed) {
        next.setAttribute('aria-current', 'page')
        next.scrollIntoView({ block: 'nearest' })
      }
    })
  }, [indices, viewportPage])

  const pick = (index: number) => {
    if (!snap) return
    const view = editor.view
    const wrap = view.dom.closest<HTMLElement>('.page-wrap')
    const scroller = view.dom.closest<HTMLElement>('.editor-scroll')
    if (!wrap || !scroller) return
    const page = snap.pages[index]
    const wrapTop =
      wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = wrapTop + page.top * zoom - 8
    const bottom = page.top + page.height
    const onPage = (b: ThumbBlock) => b.el.isConnected && b.top + b.height > page.top + 1
    // a block cut by the page top (table, long paragraph) starts on the previous page
    const first =
      snap.blocks.find((b) => onPage(b) && b.top >= page.top - 1 && b.top < bottom) ??
      snap.blocks.find(onPage)
    let pos: number | null = null
    if (first) {
      try {
        pos = view.posAtDOM(first.el, 0)
      } catch {
        pos = null
      }
    }
    if (pos === null) return
    const sel = TextSelection.near(view.state.doc.resolve(pos), 1)
    view.dispatch(view.state.tr.setSelection(sel))
    view.focus()
  }

  if (!snap) return <div className="nav-empty">{t('appNavPagesPending')}</div>
  const scale = Math.max(0.05, Math.min(width - THUMB_GUTTER * 2, THUMB_MAX_W) / snap.pageW)
  if (indices.length === 0) return <div className="nav-empty">{t('appNavNoResults')}</div>
  return (
    <div className="nav-pages" ref={listRef}>
      {indices.map((i) => (
        <Thumb
          key={i}
          snap={snap}
          index={i}
          scale={scale}
          blocks={groupedBlocks[i]}
          hit={!!hitPages?.has(i)}
          onPick={pick}
        />
      ))}
    </div>
  )
}
