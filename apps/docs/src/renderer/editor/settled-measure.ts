import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

/** CSS floats: the only layout where a paragraph's vertical position changes its line breaks */
// wrap-around floats the paragraphs flow beside (explicit classes: an
// attribute-substring selector scanned the whole editor on every keystroke)
const FLOAT_SELECTOR = [
  ...['square', 'tight', 'through'].flatMap((mode) =>
    ['left', 'right'].flatMap((side) => [
      `.img-wrap-${mode}-${side}`,
      `.doc-inline-img--wrap-${mode}-${side}`,
    ]),
  ),
  '.doc-table-float-left',
  '.doc-table-float-right',
  '.doc-table-float-center',
  '.doc-cell-boxes',
].join(', ')

/** float bands of one editor state, shared by every cache measuring against it */
const floatBandsByState = new WeakMap<object, number[][]>()
/** the float elements of the last scan of one editor; null once a transaction may have added one */
let floatScan: { dom: Element; els: Element[] } | null = null

/** Only a transaction that inserts something other than text can add a float:
 *  plain typing keeps the element list and re-reads the boxes. */
export function noteFloatTransaction(tr: Transaction): void {
  if (!floatScan || !tr.docChanged) return
  for (const step of tr.steps) {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue
    if (step instanceof ReplaceStep && step.slice.openStart === 0 && step.slice.openEnd === 0) {
      let text = true
      step.slice.content.forEach((n) => {
        if (!n.isText) text = false
      })
      if (text) continue
    }
    floatScan = null
    return
  }
}

function floatBandsOf(view: EditorView): number[][] {
  const state = (view as { state?: object }).state
  const cached = state && floatBandsByState.get(state)
  if (cached) return cached
  if (!floatScan || floatScan.dom !== view.dom || floatScan.els.some((f) => !f.isConnected))
    floatScan = { dom: view.dom, els: Array.from(view.dom.querySelectorAll(FLOAT_SELECTOR)) }
  // a floating table the paginator flows in place (doc-table-float-flow, a
  // decoration class) is not a float for this pass
  const bands = floatScan.els
    .filter((f) => !f.classList.contains('doc-table-float-flow'))
    .map((f) => {
      const r = f.getBoundingClientRect()
      const cs = getComputedStyle(f)
      return [
        r.top - (parseFloat(cs.marginTop) || 0),
        r.bottom + (parseFloat(cs.marginBottom) || 0),
      ]
    })
  if (state) floatBandsByState.set(state, bands)
  return bands
}

/**
 * Run a paragraph measurement against its natural wrap. The paginator's
 * inline page-gap widget forces a line break at the previous pass's cut, so
 * a decision read with it in layout depends on when that pass ran relative
 * to this one (two orders, two page counts); hidden, the paragraph wraps as
 * the paginator itself measures it (its measuring-natural state).
 */
export function measureNatural<T>(el: HTMLElement, fn: () => T): T {
  return withInlineGapsHidden(Array.from(el.querySelectorAll<HTMLElement>('.page-gap-inline')), fn)
}

function withInlineGapsHidden<T>(gaps: readonly HTMLElement[], fn: () => T): T {
  if (gaps.length === 0) return fn()
  const prev = gaps.map((g) => g.style.display)
  gaps.forEach((g) => (g.style.display = 'none'))
  try {
    return fn()
  } finally {
    gaps.forEach((g, i) => (g.style.display = prev[i]))
  }
}

interface Entry<T> {
  /** paragraph start when measured; results are stored at that offset */
  pos: number
  el: HTMLElement
  /** position-independent identity of the result */
  key: string
  rectKey: string
  result: T
  settled: boolean
  /** distinct results seen so far */
  rounds: number
  /** An empty result caused by style eligibility, independently of line layout. */
  excludedByStyle?: (style: CSSStyleDeclaration) => boolean
  /** last pass that visited the paragraph (unvisited entries are pruned) */
  gen: number
}

export type ReuseNoOpWhile = (excludedByStyle: (style: CSSStyleDeclaration) => boolean) => void

interface ParagraphPosition {
  node: ProseMirrorNode
  pos: number
}

/**
 * A paragraph whose compression re-wraps its own lines can answer differently
 * every round without ever repeating itself. Each answer fits the lines it
 * was measured against, so after this many the last one stays; otherwise the
 * whole document re-measures every unsettled paragraph on every round until
 * the loop's signature cap freezes it (12 rounds on a 6k-paragraph document).
 */
export const MAX_PARA_ROUNDS = 3

/**
 * Per-paragraph result cache for the measure → decorate → re-measure loops of
 * the shrink extensions. The loop re-enters synchronously, so only the
 * extension's own decorations change between passes: a paragraph whose last
 * two results agree and whose box is unchanged would measure the same again,
 * and the costly per-word/per-char DOM walk is skipped.
 *
 * Entries key on the paragraph node's identity, so an edit elsewhere in the
 * document keeps every untouched paragraph's settled result (ProseMirror
 * shares unchanged nodes across states); only its positions shift, which
 * `shift` re-bases. Callers clear() when layout inputs change (resize, font
 * load, document stylesheet).
 */
export class SettledParagraphCache<T> {
  private results = new Map<ProseMirrorNode, Entry<T>>()
  private floatBands: number[][] = []
  private gen = 0

  /**
   * @param shift re-bases a stored result to a paragraph that moved by delta
   * @param stableNow a result that changes nothing about the paragraph's
   *   own decorations (nothing to shrink) cannot alter its layout, so it is
   *   settled after a single pass
   */
  constructor(
    private shift: (result: T, delta: number) => T,
    private stableNow: (result: T) => boolean = () => false,
  ) {}

  clear(): void {
    this.results.clear()
  }

  /** once per pass: vertical bands beside which text wraps; drops paragraphs the previous pass never visited */
  beginPass(view: EditorView): void {
    this.gen++
    for (const [node, entry] of this.results)
      if (entry.gen < this.gen - 1) this.results.delete(node)
    this.floatBands = floatBandsOf(view)
  }

  measurePass(
    view: EditorView,
    paragraphs: ParagraphPosition[],
    read: (para: ParagraphPosition, el: HTMLElement, reuseNoOpWhile: ReuseNoOpWhile) => T | null,
  ): Array<T | null> {
    this.beginPass(view)
    const roots = topLevelBlockDom(view)
    const mounted = paragraphs.map((para) => ({
      para,
      el: roots.get(para.node) ?? view.nodeDOM(para.pos),
    }))
    const natural = new Set<HTMLElement>()
    const gaps: HTMLElement[] = []
    // In normal flow, removing one paragraph's gap changes later paragraphs'
    // vertical position but not their width. Columns, floats and cells may couple them.
    if (this.floatBands.length === 0) {
      for (const { para, el } of mounted) {
        if (!(el instanceof HTMLElement) || el.parentElement !== view.dom || natural.has(el))
          continue
        const own = el.querySelectorAll<HTMLElement>('.page-gap-inline')
        if (own.length === 0) continue
        const previous = this.results.get(para.node)
        if (previous?.el === el && previous.excludedByStyle?.(getComputedStyle(el))) continue
        natural.add(el)
        for (const gap of own) gaps.push(gap)
      }
    }
    const batch =
      natural.size > 1 &&
      !(Number(getComputedStyle(view.dom).columnCount) > 1) &&
      !view.dom.querySelector(
        '.doc-hf-wrap-float, .doc-col-split-float, .doc-para-frame-float, .doc-textbox-side, .has-drop-cap',
      )
    return withInlineGapsHidden(batch ? gaps : [], () =>
      mounted.map(({ para, el }) =>
        el instanceof HTMLElement
          ? this.measure(
              view,
              para.node,
              para.pos,
              (dom, reuse) => read(para, dom, reuse),
              el,
              batch && natural.has(el),
            )
          : null,
      ),
    )
  }

  measure(
    view: EditorView,
    node: ProseMirrorNode,
    pos: number,
    measureParagraph: (el: HTMLElement, reuseNoOpWhile: ReuseNoOpWhile) => T | null,
    dom?: HTMLElement,
    natural = false,
  ): T | null {
    const el = dom ?? view.nodeDOM(pos)
    if (!(el instanceof HTMLElement)) return null
    const entry = this.results.get(node)
    let prev = entry?.el === el ? entry : undefined
    if (prev) prev.gen = this.gen
    if (prev?.excludedByStyle) {
      const style = getComputedStyle(el)
      // Alignment and direction do not depend on an inline page-gap's display.
      if (!prev.excludedByStyle(style)) prev = undefined
      else if (
        el.parentElement === view.dom &&
        style.display === 'block' &&
        style.cssFloat === 'none' &&
        style.writingMode === 'horizontal-tb' &&
        (style.position === 'static' || style.position === 'relative') &&
        // The gap does not set a normal-flow block's width. Still check the
        // drawn box so hidden paragraphs go through the natural-layout retry.
        el.offsetWidth > 0 &&
        el.getBoundingClientRect().width > 0
      )
        return this.resultAt(prev, pos)
    }
    const measure = () => this.measureEl(node, pos, el, measureParagraph, prev)
    return natural ? measure() : measureNatural(el, measure)
  }

  private measureEl(
    node: ProseMirrorNode,
    pos: number,
    el: HTMLElement,
    measureParagraph: (el: HTMLElement, reuseNoOpWhile: ReuseNoOpWhile) => T | null,
    prev: Entry<T> | undefined,
  ): T | null {
    // layout px: a page-zoom transform changes no line break
    let rectKey = `${el.offsetHeight}:${el.offsetWidth}`
    if (this.floatBands.length > 0) {
      const r = el.getBoundingClientRect()
      if (this.floatBands.some(([top, bottom]) => r.top < bottom && r.bottom > top))
        rectKey = `${r.top}:${rectKey}`
    }
    if (prev?.settled && prev.rectKey === rectKey) return this.resultAt(prev, pos)

    let excludedByStyle: Entry<T>['excludedByStyle']
    const result = measureParagraph(el, (check) => (excludedByStyle = check))
    if (result === null) {
      this.results.delete(node)
      return null
    }
    const key = JSON.stringify(this.shift(result, -pos))
    const rounds = (prev?.rounds ?? 0) + 1
    this.results.set(node, {
      pos,
      el,
      key,
      rectKey,
      result,
      settled:
        (prev !== undefined && prev.key === key) ||
        this.stableNow(result) ||
        rounds >= MAX_PARA_ROUNDS,
      rounds,
      excludedByStyle,
      gen: this.gen,
    })
    return result
  }

  private resultAt(entry: Entry<T>, pos: number): T {
    return entry.pos === pos ? entry.result : this.shift(entry.result, pos - entry.pos)
  }
}

/**
 * Top-level block nodes → their DOM, read off ProseMirror's view descriptors
 * in one walk; view.nodeDOM(pos) descends through every top-level block for
 * each call, which made a pass over N paragraphs cost N².
 */
export function topLevelBlockDom(view: Pick<EditorView, 'dom'>): Map<ProseMirrorNode, HTMLElement> {
  const map = new Map<ProseMirrorNode, HTMLElement>()
  const duplicates = new Set<ProseMirrorNode>()
  for (const child of Array.from(view.dom.childNodes)) {
    const node = (child as { pmViewDesc?: { node?: ProseMirrorNode } }).pmViewDesc?.node
    if (!node || !(child instanceof HTMLElement) || duplicates.has(node)) continue
    if (map.delete(node)) duplicates.add(node)
    else map.set(node, child)
  }
  return map
}
