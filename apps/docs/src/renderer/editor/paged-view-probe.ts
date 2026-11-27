import { NodeSelection, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state'
import type { DirectEditorProps, EditorView } from '@tiptap/pm/view'
import type { PageLayout } from './goto'
import { hasRevisionAnchors } from './margin-annotations'
import { appliedInlineEditIndex } from './pagination-fast-path'
import { collectRevisions } from './revisions'
import { hasCoupledWrapGeometry } from './settled-measure'

interface Box {
  element: Element
  top: number
  bottom: number
  before: number
  after: number
}

interface Range {
  start: number
  end: number
  top: number
  bottom: number
}

interface ViewInternals {
  docView: { update(...args: unknown[]): boolean }
  domObserver: { start(): void; stop(): void }
  updateStateInner(state: EditorState, props: DirectEditorProps): void
}

const activeViews = new WeakMap<EditorView, PagedViewProbe>()
const extentStyles = ['box-sizing', 'block-size', 'min-block-size'] as const
const restoreEvents = ['beforeinput', 'compositionstart', 'cut', 'paste', 'dragstart', 'drop']

function firstMatching<T>(items: readonly T[], matches: (item: T) => boolean): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (matches(items[middle]!)) high = middle
    else low = middle + 1
  }
  return low
}

function groupOverlaps(boxes: readonly Box[]): Range[] {
  const followingTop = new Float64Array(boxes.length + 1)
  followingTop[boxes.length] = Infinity
  for (let index = boxes.length - 1; index >= 0; index--)
    followingTop[index] = Math.min(boxes[index]!.top, followingTop[index + 1]!)
  const groups: Range[] = []
  let start = 0
  let bottom = -Infinity
  boxes.forEach((box, index) => {
    bottom = Math.max(bottom, box.bottom)
    if (bottom > followingTop[index + 1]!) return
    groups.push({ start, end: index + 1, top: followingTop[start]!, bottom })
    start = index + 1
    bottom = -Infinity
  })
  return groups
}

function cssLength(value: string): number {
  return Number.parseFloat(value) || 0
}

export function pagedViewProbe(view: EditorView): PagedViewProbe | undefined {
  return activeViews.get(view)
}

export interface ParagraphEditMeasurement {
  node: EditorState['doc']
  element: HTMLElement
  from: number
  to: number
}

/** A document-wide reader needs the full view unless this update owns a single
 * independent paragraph. Offscreen nodes have no usable DOM geometry. */
export function paragraphEditMeasurement(view: EditorView): ParagraphEditMeasurement | undefined {
  const probe = pagedViewProbe(view)
  const paragraph = probe?.measurementScope()
  if (!paragraph) probe?.restore()
  return paragraph
}

export function revealDocumentRange(view: EditorView, from: number, to = from): void {
  activeViews.get(view)?.reveal(from, to)
}

export function prepareSmoothDocumentScroll(view: EditorView, from: number): void {
  activeViews.get(view)?.reveal(from, from, true)
}

/** Local experiment for the settled, single-surface EditorView. */
export class PagedViewProbe {
  readonly hadRevisions: boolean
  private readonly coupledWrap: boolean
  private readonly root: HTMLElement
  private readonly internals: ViewInternals
  private readonly rootDesc: ViewInternals['docView']
  private readonly originalStateUpdate: ViewInternals['updateStateInner']
  private readonly originalRootUpdate: ViewInternals['docView']['update']
  private model: EditorState['doc']
  private readonly boxes: Box[]
  private readonly originals: Element[]
  private readonly byModelIndex: Array<number | undefined> = []
  private readonly gaps: HTMLElement[]
  private readonly tail: HTMLElement
  private readonly groups: Range[]
  private readonly originalStyles: Array<readonly [string, string, string]>
  private readonly overflowAnchor: string
  private readonly rootHeight: number
  private readonly paddingTop: number
  private readonly origin: number
  private readonly height: number
  private readonly scale: number
  private range?: Range
  private smoothTarget?: { range: Range; offset: number }
  private updatingParagraph = false
  private geometryPending = false

  static start(
    view: EditorView,
    pane: HTMLElement,
    layout: PageLayout,
    positions: Array<number | null>,
    scrollBuffer: number,
  ): PagedViewProbe | undefined {
    activeViews.get(view)?.restore()
    if (view.composing || view.dom.childElementCount < 250) return
    const rootStyle = getComputedStyle(view.dom)
    if (rootStyle.columnCount !== 'auto' && rootStyle.columnCount !== '1') return
    const probe = new PagedViewProbe(view, pane, layout, positions, rootStyle, scrollBuffer)
    const pin = probe.selectionGroup(view.state.selection)
    if (!pin) return
    activeViews.set(view, probe)
    probe.internals.updateStateInner = probe.updateState
    probe.rootDesc.update = probe.updateRoot
    for (const event of restoreEvents) view.dom.addEventListener(event, probe.finish, true)
    view.dom.addEventListener('keydown', probe.keyDown, true)
    pane.addEventListener('scrollend', probe.finishSmoothScroll)
    pane.ownerDocument.defaultView?.addEventListener('resize', probe.finish)
    const top = pane.scrollTop + probe.origin
    probe.mount(top, top + probe.height, probe.height * scrollBuffer, pin)
    return probe
  }

  private constructor(
    private readonly view: EditorView,
    private readonly pane: HTMLElement,
    readonly layout: PageLayout,
    private positions: Array<number | null> | undefined,
    rootStyle: CSSStyleDeclaration,
    private readonly scrollBuffer: number,
  ) {
    this.root = view.dom
    this.hadRevisions = hasRevisionAnchors(this.root) || collectRevisions(view.state.doc).length > 0
    this.coupledWrap = hasCoupledWrapGeometry(view)
    this.internals = view as unknown as ViewInternals
    this.rootDesc = this.internals.docView
    this.originalStateUpdate = this.internals.updateStateInner
    this.originalRootUpdate = this.rootDesc.update
    this.model = view.state.doc
    const body = this.root.getBoundingClientRect()
    const viewport = pane.getBoundingClientRect()
    this.scale = this.root.currentCSSZoom
    this.rootHeight = body.height / this.scale
    this.origin = viewport.top - body.top - pane.scrollTop
    const padding = (side: 'Top' | 'Left') =>
      cssLength(rootStyle[`padding${side}`]) + cssLength(rootStyle[`border${side}Width`])
    this.paddingTop = padding('Top') * this.scale
    this.height = pane.clientHeight
    this.originals = Array.from(this.root.children)
    this.boxes = this.originals.map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        element,
        top: rect.top - body.top,
        bottom: rect.bottom - body.top,
        before: cssLength(style.marginTop) * this.scale,
        after: cssLength(style.marginBottom) * this.scale,
      }
    })
    this.groups = groupOverlaps(this.boxes)
    const indices = new Map(this.originals.map((element, index) => [element as Node, index]))
    this.model.forEach((_node, offset, index) => {
      let element = view.nodeDOM(offset)
      while (element && element.parentNode !== this.root) element = element.parentNode
      this.byModelIndex[index] = element ? indices.get(element) : undefined
    })
    const makeGap = () => {
      const element = this.root.ownerDocument.createElement('div')
      element.contentEditable = 'false'
      element.setAttribute('aria-hidden', 'true')
      element.style.cssText =
        'display:block;box-sizing:border-box;margin:0;padding:0;border:0;pointer-events:none'
      return element
    }
    this.gaps = [makeGap(), makeGap(), makeGap()]
    this.tail = makeGap()
    if (pane.scrollWidth > pane.clientWidth) {
      const left =
        body.left - viewport.left + pane.scrollLeft - pane.clientLeft + padding('Left') * this.scale
      const width = `${(pane.scrollWidth - left) / this.scale}px`
      this.gaps[0]!.style.inlineSize = width
      this.tail.style.inlineSize = width
    }
    this.originalStyles = extentStyles.map((name) => [
      name,
      this.root.style.getPropertyValue(name),
      this.root.style.getPropertyPriority(name),
    ])
    this.overflowAnchor = pane.style.overflowAnchor
  }

  onScroll(top: number): void {
    if (!this.range) return
    const pin = this.selectionGroup(this.view.state.selection)
    if (!pin || this.view.composing) return this.restore()
    const from = top + this.origin
    const to = from + this.height
    const target = this.smoothTarget?.range
    if (
      target &&
      to >= target.top &&
      from <= target.bottom &&
      this.range.start <= target.start &&
      this.range.end >= target.end
    )
      this.smoothTarget = undefined
    if (
      (this.range.start === 0 || from - this.height >= this.range.top) &&
      (this.range.end === this.boxes.length || to + this.height <= this.range.bottom)
    )
      return
    this.mount(from, to, this.height * this.scrollBuffer, pin)
  }

  reveal(from: number, to: number, smooth = false): void {
    const target = this.groupAt(from)
    const end = this.groupAt(to)
    const pin = this.selectionGroup(this.view.state.selection)
    if (!target || target !== end || !pin) return this.restore()
    if (this.boxes[target.start]!.element.parentNode === this.root) return
    const box = this.boxes[this.indexAt(from)!]!
    let gap: HTMLElement | undefined
    if (smooth && this.range) {
      this.smoothTarget = { range: target, offset: 0 }
      gap = this.present(this.range, pin, target.start)
    } else {
      this.smoothTarget = undefined
      gap = this.mount(box.top, Math.min(box.bottom, box.top + this.height), this.height * 4, pin)
    }
    if (!gap) return
    const projected =
      box.element.getBoundingClientRect().top - this.root.getBoundingClientRect().top
    const shift = (box.top - projected) / this.scale
    if (Math.abs(shift) >= 0.05) {
      gap.style.blockSize = `${Math.max(0, cssLength(gap.style.blockSize) + shift)}px`
      if (this.smoothTarget) this.smoothTarget.offset = shift
    }
  }

  get hasPendingGeometry(): boolean {
    return this.geometryPending
  }

  measurementScope(): ParagraphEditMeasurement | undefined {
    if (!this.updatingParagraph || this.coupledWrap) return
    const element = this.selectedParagraph()
    if (!(element instanceof HTMLElement)) return
    const { $from } = this.view.state.selection
    const from = $from.before(1)
    return { node: $from.parent, element, from, to: from + $from.parent.nodeSize }
  }

  keepGeometry(): void {
    this.geometryPending = false
  }

  pagePositions(layout: PageLayout): Array<number | null> | undefined {
    return layout === this.layout ? this.positions : undefined
  }

  restore(observerRunning = true): void {
    this.leaveWindow(observerRunning, true)
  }

  private leaveWindow(observerRunning: boolean, reconnect: boolean): void {
    if (!this.range) return
    this.range = undefined
    activeViews.delete(this.view)
    this.internals.updateStateInner = this.originalStateUpdate
    this.rootDesc.update = this.originalRootUpdate
    for (const event of restoreEvents) this.root.removeEventListener(event, this.finish, true)
    this.root.removeEventListener('keydown', this.keyDown, true)
    this.pane.removeEventListener('scrollend', this.finishSmoothScroll)
    this.pane.ownerDocument.defaultView?.removeEventListener('resize', this.finish)
    this.editDOM(() => {
      if (reconnect) this.reconcile(this.originals)
      for (const [name, value, priority] of this.originalStyles)
        this.root.style.setProperty(name, value, priority)
      this.pane.style.overflowAnchor = this.overflowAnchor
    }, observerRunning)
  }

  private finish = (event: Event): void => {
    if (
      event instanceof InputEvent &&
      event.type === 'beforeinput' &&
      event.inputType === 'insertText' &&
      !event.isComposing &&
      this.view.editable &&
      this.view.hasFocus()
    ) {
      const block = this.selectedParagraph()
      const targets = event.getTargetRanges()
      if (
        block &&
        targets.length === 1 &&
        block.contains(targets[0]!.startContainer) &&
        block.contains(targets[0]!.endContainer)
      )
        return
    }
    this.restore()
  }

  private finishSmoothScroll = (): void => {
    if (!this.smoothTarget || !this.range) return
    this.onScroll(this.pane.scrollTop)
    if (!this.smoothTarget || !this.range) return
    this.smoothTarget = undefined
    const pin = this.selectionGroup(this.view.state.selection)
    if (pin) this.present(this.range, pin, this.range.start)
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Meta' ||
      event.key === 'Alt'
    )
      return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') return
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing &&
      this.selectedParagraph()
    )
      return
    this.restore()
  }

  private selectedParagraph(): Element | undefined {
    const { selection } = this.view.state
    if (!(selection instanceof TextSelection)) return
    const { $from, $to } = selection
    if ($from.depth !== 1 || $from.parent.type.name !== 'docParagraph' || !$from.sameParent($to))
      return
    const index = this.byModelIndex[$from.index(0)]
    const element = index === undefined ? undefined : this.boxes[index]?.element
    return element?.parentNode === this.root ? element : undefined
  }

  private updatesSelectedParagraph(state: EditorState): boolean {
    if (
      this.view.composing ||
      this.coupledWrap ||
      !this.selectedParagraph() ||
      !(state.selection instanceof TextSelection) ||
      state.plugins !== this.view.state.plugins ||
      state.doc.childCount !== this.model.childCount ||
      !state.doc.sameMarkup(this.model)
    )
      return false
    const before = this.view.state.selection.$from
    const after = state.selection.$from
    const index = before.index(0)
    return (
      appliedInlineEditIndex(this.view.state, state) === index &&
      after.depth === 1 &&
      after.index(0) === index &&
      after.parent.sameMarkup(before.parent) &&
      state.selection.to <= after.end()
    )
  }

  private updateState = (state: EditorState, props: DirectEditorProps): void => {
    if (
      !this.updatingParagraph &&
      state.doc !== this.model &&
      this.updatesSelectedParagraph(state)
    ) {
      this.model = state.doc
      this.positions = undefined
      this.geometryPending = true
      this.updatingParagraph = true
      try {
        this.originalStateUpdate.call(this.view, state, props)
      } finally {
        this.updatingParagraph = false
      }
      return
    }
    if (state.doc !== this.model || state.plugins !== this.view.state.plugins) {
      this.restore()
    } else if (!state.selection.eq(this.view.state.selection)) {
      const group = this.selectionGroup(state.selection)
      if (!group || this.boxes[group.start]!.element.parentNode !== this.root) this.restore()
    }
    this.originalStateUpdate.call(this.view, state, props)
  }

  private updateRoot = (...args: unknown[]): boolean => {
    // Upstream has suspended its observer before mutating the view tree.
    if (!this.updatingParagraph) {
      this.restore(false)
      return this.originalRootUpdate.apply(this.rootDesc, args)
    }
    const updated = this.originalRootUpdate.apply(this.rootDesc, args)
    if (!updated) this.restore(false)
    // A descriptor change may make ProseMirror reconcile the whole root.
    // Its new children then own the DOM. Discard our snapshot without replaying it.
    else if (this.gaps[0]!.parentNode !== this.root) this.leaveWindow(false, false)
    return updated
  }

  private indexAt(pos: number): number | undefined {
    const index = this.model.resolve(pos).index(0)
    return this.byModelIndex[Math.min(index, this.byModelIndex.length - 1)]
  }

  private groupAt(pos: number): Range | undefined {
    const index = this.indexAt(pos)
    return index === undefined
      ? undefined
      : this.groups[firstMatching(this.groups, (group) => group.end > index)]
  }

  private selectionGroup(selection: Selection): Range | undefined {
    const first = this.groupAt(selection.from)
    if (selection instanceof NodeSelection || selection.empty) return first
    return first === this.groupAt(selection.to) ? first : undefined
  }

  private mount(from: number, to: number, buffer: number, pin: Range): HTMLElement | undefined {
    const left = Math.min(
      firstMatching(this.groups, (group) => group.bottom > from - buffer),
      this.groups.length - 1,
    )
    const right = firstMatching(this.groups, (group) => group.top >= to + buffer)
    const lead = this.groups[left]!
    const end = this.groups[Math.max(left + 1, right) - 1]!
    const next = { start: lead.start, end: end.end, top: lead.top, bottom: end.bottom }
    if (this.range?.start === next.start && this.range.end === next.end) return
    return this.present(next, pin, next.start)
  }

  private present(next: Range, pin: Range, focus: number): HTMLElement | undefined {
    if (this.geometryPending) {
      this.restore()
      return
    }
    const target = this.smoothTarget
    const sorted = target ? [next, pin, target.range] : [next, pin]
    sorted.sort((a, b) => a.start - b.start)
    const segments: Range[] = []
    for (const range of sorted) {
      const preceding = segments.at(-1)
      if (preceding && preceding.end >= range.start) {
        if (range.end > preceding.end)
          segments[segments.length - 1] = { ...preceding, end: range.end, bottom: range.bottom }
      } else segments.push(range)
    }
    const desired: Element[] = []
    let previousBottom = this.paddingTop
    const leading =
      this.gaps[segments.findIndex((segment) => focus >= segment.start && focus < segment.end)]
    this.editDOM(() => {
      if (!this.range) {
        this.root.style.setProperty('box-sizing', 'border-box', 'important')
        this.root.style.setProperty('block-size', `${this.rootHeight}px`, 'important')
        this.root.style.setProperty('min-block-size', `${this.rootHeight}px`, 'important')
        this.pane.style.overflowAnchor = 'none'
      }
      segments.forEach((segment, index) => {
        const gap = this.gaps[index]!
        const first = this.boxes[segment.start]!
        const shift = target?.range.start === segment.start ? target.offset : 0
        gap.style.blockSize = `${Math.max(0, (first.top - previousBottom - first.before) / this.scale + shift)}px`
        desired.push(gap, ...this.originals.slice(segment.start, segment.end))
        previousBottom = segment.bottom + this.boxes[segment.end - 1]!.after
      })
      this.tail.style.blockSize = segments.at(-1)?.end === this.boxes.length ? '0px' : '1px'
      desired.push(this.tail)
      this.reconcile(desired)
    })
    this.range = next
    return leading
  }

  private editDOM(action: () => void, observerRunning = true): void {
    const observer = this.internals.domObserver
    if (observerRunning) observer.stop()
    try {
      action()
    } finally {
      if (observerRunning) observer.start()
    }
  }

  private reconcile(desired: readonly Element[]): void {
    const keep = new Set<Node>(desired)
    for (const node of Array.from(this.root.childNodes)) if (!keep.has(node)) node.remove()
    let cursor = this.root.firstChild
    for (const node of desired) {
      if (node === cursor) cursor = cursor.nextSibling
      else this.root.insertBefore(node, cursor)
    }
  }
}
