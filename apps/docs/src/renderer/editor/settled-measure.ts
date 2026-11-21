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
  '.doc-col-split-float',
  '.doc-hf-wrap-float',
  '.doc-para-frame-float',
  '.doc-textbox-side',
].join(', ')

function requiresFullWrapMeasure(view: Pick<EditorView, 'dom'>): boolean {
  // Drop caps have no DOM box, and a legacy frame can change its own float
  // width as its text wraps. Recheck the flow in both cases.
  return (
    Number(getComputedStyle(view.dom).columnCount) > 1 ||
    view.dom.querySelector('.has-drop-cap, .doc-para-frame-box-float') !== null
  )
}

export function hasCoupledWrapGeometry(view: Pick<EditorView, 'dom'>): boolean {
  return (
    requiresFullWrapMeasure(view) ||
    Array.from(view.dom.querySelectorAll(FLOAT_SELECTOR)).some(isFloat)
  )
}

interface FloatElement {
  element: Element
  context: Element
}

interface FloatBand {
  top: number
  bottom: number
  shape: string
}

// Cell floats stay in their cell's formatting context. A band host likewise
// contains its own full-width wrapTopAndBottom float (display: flow-root).
const LOCAL_FLOW = 'td, th, .doc-band-host'

/** Float elements of one editor state, shared by every cache measuring against it. */
const floatsByState = new WeakMap<object, FloatElement[]>()
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

function isFloat(element: Element): boolean {
  // A floating table can be flowed in place by the paginator.
  if (element.classList.contains('doc-table-float-flow')) return false
  const style = getComputedStyle(element)
  return style.cssFloat !== '' && style.cssFloat !== 'none' && style.display !== 'none'
}

function floatsOf(view: EditorView): FloatElement[] {
  const state = (view as { state?: object }).state
  const cached = state && floatsByState.get(state)
  if (cached) return cached
  if (!floatScan || floatScan.dom !== view.dom || floatScan.els.some((f) => !f.isConnected))
    floatScan = { dom: view.dom, els: Array.from(view.dom.querySelectorAll(FLOAT_SELECTOR)) }
  const floats = floatScan.els.filter(isFloat).map((element) => ({
    element,
    context: element.parentElement?.closest(LOCAL_FLOW) ?? view.dom,
  }))
  if (state) floatsByState.set(state, floats)
  return floats
}

function readFloatBand(element: Element): FloatBand {
  const r = element.getBoundingClientRect()
  const cs = getComputedStyle(element)
  return {
    top: r.top - (parseFloat(cs.marginTop) || 0),
    bottom: r.bottom + (parseFloat(cs.marginBottom) || 0),
    shape: JSON.stringify([r.left, r.right, cs.marginLeft, cs.marginRight, cs.shapeOutside]),
  }
}

function firstBodyFloatBlock(root: HTMLElement, floats: FloatElement[]): Element | undefined {
  // The selector scan orders the floats by their document position.
  let owner = floats.find((float) => float.context === root)?.element
  while (owner?.parentElement && owner.parentElement !== root) owner = owner.parentElement
  return owner
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
  coupled: boolean
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
  private previousResults?: Map<ProseMirrorNode, Entry<T> | undefined>
  private floats: FloatElement[] = []
  private floatBands = new Map<Element, FloatBand>()
  private gen = 0
  private wrapVersion = 0
  private scopedPass = false
  private rootWidth: number | undefined

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
    this.scopedPass = false
    this.results.clear()
    this.previousResults = undefined
  }

  invalidateBlocks(view: EditorView, blocks: ReadonlySet<HTMLElement>): void {
    if (blocks.size === 0) return
    this.wrapVersion++
    floatsByState.delete(view.state)
    if (floatScan?.dom === view.dom) floatScan = null
    // Balancing a common CSS column flow couples the paragraphs on both
    // sides of a changed block. Independent blocks retain their own results.
    if (requiresFullWrapMeasure(view)) {
      this.clear()
      return
    }
    this.scopedPass = true
    for (const [node, entry] of this.results) {
      let el: HTMLElement | null = entry.el
      while (el && el !== view.dom) {
        if (blocks.has(el)) {
          this.results.delete(node)
          break
        }
        el = el.parentElement
      }
    }
  }

  /** Start a new read pass and drop paragraphs the previous pass never visited. */
  beginPass(view: EditorView): void {
    this.gen++
    this.previousResults = undefined
    for (const [node, entry] of this.results)
      if (entry.gen < this.gen - 1) this.results.delete(node)
    this.floats = floatsOf(view)
    this.floatBands.clear()
  }

  /** The current boxes were measured with the still-published decorations.
   * When the next proposal is rejected, associate those boxes with that result
   * so a later edit does not restart the same cycle from unpublished work. */
  retainPublishedResults(): void {
    if (!this.previousResults) return
    for (const [node, previous] of this.previousResults) {
      const measured = this.results.get(node)
      if (!previous || !measured || previous.el !== measured.el) {
        this.results.delete(node)
        continue
      }
      this.results.set(node, {
        ...measured,
        key: previous.key,
        result: this.resultAt(previous, measured.pos),
        settled: true,
        excludedByStyle: previous.excludedByStyle,
      })
    }
    this.acceptMeasuredResults()
  }

  acceptMeasuredResults(): void {
    this.previousResults = undefined
  }

  measurePass(
    view: EditorView,
    paragraphs: ParagraphPosition[],
    read: (para: ParagraphPosition, el: HTMLElement, reuseNoOpWhile: ReuseNoOpWhile) => T | null,
    options?: { trackProposal: boolean },
  ): Array<T | null> {
    this.beginPass(view)
    if (options?.trackProposal) this.previousResults = new Map()
    // Only a scoped reuse decision needs a geometry read before hiding gaps.
    const width = this.scopedPass && this.results.size > 0 ? view.dom.offsetWidth : undefined
    const canReuse = width !== undefined && this.rootWidth === width
    this.scopedPass = false
    const roots = topLevelBlockDom(view)
    const firstFloat = firstBodyFloatBlock(view.dom, this.floats)
    const independentBody = new Set<Element>()
    // A CSS float only affects its anchor and subsequent content in the same
    // formatting context. Hiding gaps before that anchor cannot change the
    // wrap of the earlier body paragraphs.
    if (firstFloat) {
      for (const child of view.dom.children) {
        if (child === firstFloat) break
        independentBody.add(child)
      }
    }
    const mounted = paragraphs.map((para) => {
      const el = roots.get(para.node) ?? view.nodeDOM(para.pos)
      const independentBodyParagraph =
        el instanceof HTMLElement &&
        el.parentElement === view.dom &&
        (!firstFloat || independentBody.has(el))
      const previous =
        canReuse && (independentBodyParagraph || this.floats.length === 0)
          ? this.results.get(para.node)
          : undefined
      const reusable =
        previous?.settled && !previous.coupled && previous.el === el ? previous : undefined
      return { para, el, reusable, independentBodyParagraph }
    })
    const natural = new Set<HTMLElement>()
    const gaps: HTMLElement[] = []
    for (const { para, el, reusable, independentBodyParagraph } of mounted) {
      if (!independentBodyParagraph || reusable || !(el instanceof HTMLElement)) continue
      if (natural.has(el)) continue
      const own = el.querySelectorAll<HTMLElement>('.page-gap-inline')
      if (own.length === 0) continue
      const previous = this.results.get(para.node)
      if (previous?.el === el && previous.excludedByStyle?.(getComputedStyle(el))) continue
      natural.add(el)
      for (const gap of own) gaps.push(gap)
    }
    const readMounted = ({ para, el, reusable }: (typeof mounted)[number], hideBatch: boolean) => {
      if (reusable) {
        reusable.gen = this.gen
        return this.resultAt(reusable, para.pos)
      }
      return el instanceof HTMLElement
        ? this.measure(
            view,
            para.node,
            para.pos,
            (dom, reuse) => read(para, dom, reuse),
            el,
            hideBatch,
          )
        : null
    }
    let measured: Array<T | null>
    if (natural.size < 2 || requiresFullWrapMeasure(view)) {
      measured = mounted.map((item) => readMounted(item, false))
    } else {
      measured = new Array<T | null>(mounted.length)
      withInlineGapsHidden(gaps, () => {
        mounted.forEach((item, i) => {
          if (item.independentBodyParagraph && item.el instanceof HTMLElement)
            measured[i] = readMounted(item, natural.has(item.el))
        })
      })
      // Restore the body gaps before reading any coupled or table paragraph.
      mounted.forEach((item, i) => {
        if (!item.independentBodyParagraph) measured[i] = readMounted(item, false)
      })
    }
    this.rootWidth = width ?? view.dom.offsetWidth
    return measured
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
    const measure = () => this.measureEl(view, node, pos, el, measureParagraph, prev)
    return natural ? measure() : measureNatural(el, measure)
  }

  private measureEl(
    view: EditorView,
    node: ProseMirrorNode,
    pos: number,
    el: HTMLElement,
    measureParagraph: (el: HTMLElement, reuseNoOpWhile: ReuseNoOpWhile) => T | null,
    prev: Entry<T> | undefined,
  ): T | null {
    // layout px: a page-zoom transform changes no line break
    let rectKey = `${el.offsetHeight}:${el.offsetWidth}`
    let coupled = false
    let rect: DOMRect | undefined
    for (const { context, element } of this.floats) {
      if (context !== view.dom && !context.contains(el)) continue
      const ownsFloat = el.contains(element)
      const order = el.compareDocumentPosition(element)
      if (
        !ownsFloat &&
        !(order & Node.DOCUMENT_POSITION_DISCONNECTED) &&
        order & Node.DOCUMENT_POSITION_FOLLOWING
      )
        continue
      // Hiding the gap may move a float anchored inside this paragraph.
      let band = ownsFloat ? undefined : this.floatBands.get(element)
      if (!band) {
        band = readFloatBand(element)
        if (!ownsFloat) this.floatBands.set(element, band)
      }
      rect ??= el.getBoundingClientRect()
      if (rect.top >= band.bottom || rect.bottom <= band.top) continue
      coupled = true
      rectKey += `:${this.wrapVersion}:${band.top - rect.top}:${band.bottom - rect.top}:${band.shape}`
    }
    if (prev?.settled && prev.rectKey === rectKey) return this.resultAt(prev, pos)

    let excludedByStyle: Entry<T>['excludedByStyle']
    const result = measureParagraph(el, (check) => (excludedByStyle = check))
    if (this.previousResults && !this.previousResults.has(node))
      this.previousResults.set(node, this.results.get(node))
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
      coupled,
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
