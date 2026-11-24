import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { PluginKey } from '@tiptap/pm/state'
import { presentationPlugin } from './authored-document'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { splitFloatStyle } from '../pagination-lines'
import type { ColumnSplitShape, VerticalBlockSpec } from '../pagination-types'
import { TopLevelPositions, topLevelDomRanges } from './top-level-pos'
import type { LayoutBatch } from './pagination-gaps'
import { columnDecoration, mapColumnDecorations, type ColumnFrame } from './column-layout-recovery'
import { paragraphDecorationsChanged } from './settled-measure'

const key = new PluginKey<DecorationSet>('columnLayout')
export const WRAP_WIDTHS_COMMITTED_EVENT = 'genoffice:wrap-widths'
/** Null indicates that simultaneous changes can affect blocks outside the set. */
export type WrapWidthChanges = ReadonlySet<HTMLElement> | null

const committedWrap = new WeakMap<EditorView, Map<HTMLElement, string>>()
const columnFramesByView = new WeakMap<EditorView, InstalledColumnFrames>()
const widgetFramesByView = new WeakMap<EditorView, ReadonlyMap<HTMLElement, ColumnFrame>>()

/**
 * Mixed-column canvas layout (documents whose sections disagree on column
 * count/width, so the uniform whole-page CSS multicol path can't apply).
 *
 * The engine keeps its 1-D single-flow virtual coordinates; this extension only
 * *paints* the flow into columns: each block in a multi-column region gets its
 * section's column width plus a constant per-column translate, and blocks of
 * later regions on the same page translate up over the space the columns
 * vacated (the page gap below pulls the next page up by the same amount).
 * Decorations are visual-only; measurement runs in the `.measuring-columns`
 * state, whose CSS neutralizes the transforms (widths stay — the engine's line
 * boxes must reflect column wrapping).
 *
 * v1 granularity: a block is placed whole into the column containing its top;
 * a block the engine split across columns paints overflowing its column bottom.
 */
export const ColumnLayoutExtension = Extension.create({
  name: 'columnLayout',
  // Widths must be installed before tab and paragraph view plugins read them.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      presentationPlugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set, oldState) {
            const next = tr.getMeta(key) as DecorationSet | undefined
            if (next) return next
            return mapColumnDecorations(set, tr, oldState.doc)
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
        },
        view(view) {
          publishColumnFrames(view)
          return {
            update(_, previous) {
              const state = view.state
              // DOM-observer repairs can redraw a block with the very same
              // state. Other decoration updates can also replace a view node.
              if (
                state === previous ||
                state.doc !== previous.doc ||
                (columnFramesByView.get(view)?.size &&
                  paragraphDecorationsChanged(state, previous)) ||
                key.getState(state) !== key.getState(previous)
              )
                publishColumnFrames(view)
            },
            destroy() {
              // ProseMirror stops its observer before disposing plugin views.
              // A replacement publisher can reuse this state synchronously;
              // only an editor that stays alive without the plugin needs cleanup.
              const installed = columnFramesByView.get(view)
              queueMicrotask(() => {
                if (
                  !installed ||
                  view.isDestroyed ||
                  key.get(view.state) ||
                  columnFramesByView.get(view) !== installed
                )
                  return
                updateColumnFrames(view, installed, new Map())
                columnFramesByView.delete(view)
                widgetFramesByView.delete(view)
              })
            },
          }
        },
      }),
    ]
  },
})

export interface ColumnBlockSpec {
  /** top-level block element (same anchoring as page gaps) */
  el: HTMLElement
  /** column width (px); absent for single-column regions (natural width) */
  widthPx?: number
  /** owning section's content width (--doc-content-w): tables resolve their spill/centering caps against it */
  contentWPx?: number
  /** owning section's side margins (--doc-margin-left/right overrides) */
  marginLeftPx?: number
  marginRightPx?: number
  /** owning section's top margin (--doc-margin-top override) in docs whose sections disagree on it */
  marginTopPx?: number
  /** owning section's typed docGrid pitch (pt) in mixed-grid docs; 0 = untyped
   *  section (opts out like snapToGrid=0 via doc-grid-nosnap) */
  gridPitchPt?: number
  /** owning section's character-grid letter-spacing delta (pt) in docs whose
   *  sections disagree on docGrid charSpace (doc-charspace-block) */
  charSpacePt?: number
  charSpaceSbPt?: number
  /** translate; dy < 0 pulls content up over vacated column space */
  dx: number
  dy: number
  /** left edge of the block's page on the shared paper (--page-cx); not undone by page-relative anchors */
  pageDx?: number
  /** vertical-text section block (doc-vert-block): writing-mode box, see verticalTextSpecs */
  vertical?: VerticalBlockSpec
  /** paragraph straddling two columns of different widths: a leading float
   *  (doc-col-split-float) rewraps the head or the tail at the narrower width */
  split?: ColumnSplitShape
  /** first block of a page-opening section (doc-sect-page-start: clear floats) */
  sectionPageStart?: true
}

const SPLIT_CLASS = 'doc-col-split-float'

function splitFloatEl(owner: Document, style: string): HTMLElement {
  const span = owner.createElement('span')
  span.className = SPLIT_CLASS
  span.contentEditable = 'false'
  span.setAttribute('aria-hidden', 'true')
  span.style.cssText = style
  return span
}

export function columnSplitDecoration(pos: number, style: string): Decoration {
  return Decoration.widget(pos, (view) => splitFloatEl(view.dom.ownerDocument, style), {
    side: -1,
    key: `col-split-${style}`,
    ignoreSelection: true,
    viewportColumnSplit: style,
  })
}

const PATCH_PROPS = [
  '--col-w',
  '--col-dx',
  '--col-dy',
  '--page-cx',
  '--doc-content-w',
  '--doc-margin-left',
  '--doc-margin-right',
  '--doc-margin-top',
  '--doc-grid-pitch',
  '--doc-char-space',
  '--doc-char-space-sb',
  '--vert-mb',
]

const PATCH_CLASSES = [
  'doc-col-block',
  'doc-grid-block',
  'doc-grid-nosnap',
  'doc-charspace-block',
  'doc-vert-block',
  'doc-vert-first',
  'doc-vert-tbRl',
  'doc-vert-tbRlV',
  'doc-vert-btLr',
  'doc-sect-page-start',
]

interface OwnedProperty {
  authored: string
  priority: string
  applied: string
}

interface InstalledColumnFrame {
  node?: ProseMirrorNode
  frame: ColumnFrame
  properties: Map<string, OwnedProperty>
}

type InstalledColumnFrames = Map<HTMLElement, InstalledColumnFrame>

/** Keep authored declarations underneath the values temporarily owned by pagination. */
function writeColumnFrame(
  element: HTMLElement,
  installed: Map<string, OwnedProperty>,
  frame?: ColumnFrame,
): void {
  const classes = new Set(frame?.class.split(' '))
  for (const name of PATCH_CLASSES) {
    const enabled = classes.has(name)
    if (element.classList.contains(name) !== enabled) element.classList.toggle(name, enabled)
  }
  const properties = new Map<string, string>()
  for (const declaration of frame?.style.split(';') ?? []) {
    const colon = declaration.indexOf(':')
    properties.set(declaration.slice(0, colon), declaration.slice(colon + 1))
  }
  for (const name of PATCH_PROPS) {
    const next = properties.get(name)
    const previous = installed.get(name)
    if (next === undefined && !previous) continue
    const current = element.style.getPropertyValue(name)
    const priority = element.style.getPropertyPriority(name)
    const stillOwned = previous !== undefined && current === previous.applied && !priority
    if (next === undefined) {
      if (stillOwned && (current !== previous.authored || previous.priority))
        element.style.setProperty(name, previous.authored, previous.priority)
      installed.delete(name)
      continue
    }
    if (current !== next || priority) element.style.setProperty(name, next)
    if (stillOwned) previous.applied = next
    else installed.set(name, { authored: current, priority, applied: next })
  }
}

function publishColumnFrames(view: EditorView): void {
  const frames = new Map<number, ColumnFrame>()
  for (const decoration of key.getState(view.state)?.find(undefined, undefined, (s) => s.frame) ??
    [])
    frames.set(decoration.from, decoration.spec.frame as ColumnFrame)
  const targets = new Map<HTMLElement, { node?: ProseMirrorNode; frame: ColumnFrame }>()
  if (frames.size > 0) {
    for (const { dom, node, from } of topLevelDomRanges(view)) {
      const frame = frames.get(from)
      if (frame && dom instanceof HTMLElement) targets.set(dom, { node, frame })
    }
  }
  for (const [dom, frame] of widgetFramesByView.get(view) ?? [])
    if (dom.parentElement === view.dom) targets.set(dom, { frame })
  columnFramesByView.set(
    view,
    updateColumnFrames(view, columnFramesByView.get(view) ?? new Map(), targets),
  )
}

function updateColumnFrames(
  view: EditorView,
  previous: InstalledColumnFrames,
  frames: ReadonlyMap<HTMLElement, { node?: ProseMirrorNode; frame: ColumnFrame }>,
): InstalledColumnFrames {
  if (frames.size === 0 && previous.size === 0) return previous
  const installed: InstalledColumnFrames = new Map()
  const observer = (view as { domObserver?: { stop(): void; start(): void } }).domObserver
  observer?.stop()
  try {
    for (const [dom, { node, frame }] of frames) {
      const last = previous.get(dom)
      if (
        last &&
        last.node === node &&
        last.frame.class === frame.class &&
        last.frame.style === frame.style
      ) {
        installed.set(dom, last)
        continue
      }
      const properties = last?.properties ?? new Map()
      writeColumnFrame(dom, properties, frame)
      installed.set(dom, { node, frame, properties })
    }
    for (const [element, frame] of previous) {
      if (!installed.has(element) && view.dom.contains(element))
        writeColumnFrame(element, frame.properties)
    }
  } finally {
    observer?.start()
  }
  return installed
}

/** pitch/charSpace-only specs get an inert marker class: .doc-col-block's
 *  width/transform rules must not touch blocks that only carry their section's
 *  grid pitch or character spacing. Pitch-0 opt-outs use their own class (same
 *  CSS as doc-nosnap): reusing doc-nosnap would trip sectionGridPitchSpecs'
 *  own-opt-out skip on the next pass and let patch cleanup strip a node's own
 *  snapToGrid=0 class. */
function specClass(spec: ColumnBlockSpec, leading = true): string {
  const varsOnly =
    (spec.gridPitchPt !== undefined ||
      spec.charSpacePt !== undefined ||
      spec.marginTopPx !== undefined ||
      spec.sectionPageStart) &&
    spec.widthPx === undefined &&
    spec.contentWPx === undefined &&
    spec.dx === 0 &&
    spec.dy === 0 &&
    !spec.pageDx
  let cls = varsOnly ? 'doc-grid-block' : 'doc-col-block'
  if (spec.gridPitchPt === 0) cls += ' doc-grid-nosnap'
  if (spec.charSpacePt !== undefined) cls += ' doc-charspace-block'
  if (leading && spec.sectionPageStart) cls += ' doc-sect-page-start'
  if (spec.vertical) {
    cls += ` doc-vert-block doc-vert-${spec.vertical.mode}`
    if (leading && spec.vertical.firstOnPage) cls += ' doc-vert-first'
  }
  return cls
}

/** Rebuild the column-layout decorations (an empty list clears them). */
export function setColumnLayout(
  view: EditorView,
  specs: ColumnBlockSpec[],
  batch?: LayoutBatch,
): ReadonlySet<HTMLElement> {
  const decos: Decoration[] = []
  const positions = new TopLevelPositions(view)
  const widgetFrames = new Map<HTMLElement, ColumnFrame>()
  const splitOf = new Map<HTMLElement, string>()
  const nextWrap = new Map<HTMLElement, string>()
  for (const spec of specs) {
    if (spec.split)
      splitOf.set(
        spec.el,
        splitFloatStyle(
          spec.split.floatPx,
          spec.split.heightPx,
          spec.split.insetPx,
          spec.split.rtl,
        ),
      )
    const wrapInputs = [
      spec.widthPx === undefined ? undefined : round2(spec.widthPx),
      spec.contentWPx === undefined ? undefined : round2(spec.contentWPx),
      spec.contentWPx === undefined ? undefined : round2(spec.marginLeftPx ?? 0),
      spec.contentWPx === undefined ? undefined : round2(spec.marginRightPx ?? 0),
      spec.gridPitchPt === undefined ? undefined : round2(spec.gridPitchPt),
      spec.charSpacePt === undefined ? undefined : round4(spec.charSpacePt),
      spec.charSpaceSbPt === undefined ? undefined : round4(spec.charSpaceSbPt),
      spec.vertical?.mode,
      spec.vertical?.firstOnPage,
      spec.sectionPageStart,
      splitOf.get(spec.el),
    ]
    if (wrapInputs.some((value) => value !== undefined))
      nextWrap.set(spec.el, JSON.stringify(wrapInputs))
    const style =
      (spec.widthPx !== undefined ? `--col-w:${round2(spec.widthPx)}px;` : '') +
      (spec.contentWPx !== undefined
        ? `--doc-content-w:${round2(spec.contentWPx)}px;--doc-margin-left:${round2(spec.marginLeftPx ?? 0)}px;--doc-margin-right:${round2(spec.marginRightPx ?? 0)}px;`
        : '') +
      (spec.marginTopPx !== undefined ? `--doc-margin-top:${round2(spec.marginTopPx)}px;` : '') +
      (spec.gridPitchPt !== undefined
        ? `--doc-grid-pitch:${spec.gridPitchPt > 0 ? `${round2(spec.gridPitchPt)}pt` : '0.0001px'};`
        : '') +
      (spec.charSpacePt !== undefined ? `--doc-char-space:${round4(spec.charSpacePt)}pt;` : '') +
      (spec.charSpaceSbPt !== undefined
        ? `--doc-char-space-sb:${round4(spec.charSpaceSbPt)}pt;`
        : '') +
      (spec.pageDx ? `--page-cx:${round2(spec.pageDx)}px;` : '') +
      (spec.vertical ? `--vert-mb:${round2(spec.vertical.marginBottomPx)}px;` : '') +
      `--col-dx:${round2(spec.dx)}px;--col-dy:${round2(spec.dy)}px`
    const cls = specClass(spec)
    const range = positions.of(spec.el)
    if (!range) {
      // Flow widgets such as a floating picture's retained anchor line have
      // geometry, but no document node for a mapped frame.
      widgetFrames.set(spec.el, { class: cls, style })
      continue
    }
    const { from, to } = range
    // Vertical placements and split-column floats depend on measured block
    // extents. Leave them on the existing mapping/pagination path instead of
    // copying stale coordinates or a float shape onto newly split paragraphs.
    const continuation =
      spec.vertical || spec.split ? undefined : { class: specClass(spec, false), style }
    decos.push(columnDecoration(from, to, { class: cls, style }, continuation))
    const split = splitOf.get(spec.el)
    if (split) decos.push(columnSplitDecoration(from + 1, split))
  }
  const next = DecorationSet.create(view.state.doc, decos)
  const prev = key.getState(view.state)
  if (!prev || !sameCols(prev, next)) {
    if (batch) batch.set(key, next)
    else view.dispatch(view.state.tr.setMeta(key, next).setMeta('addToHistory', false))
  }
  const changed = new Set<HTMLElement>()
  const previousWrap = committedWrap.get(view)
  for (const [el, inputs] of nextWrap) if (previousWrap?.get(el) !== inputs) changed.add(el)
  if (previousWrap)
    for (const el of previousWrap.keys())
      if (!nextWrap.has(el) && view.dom.contains(el)) changed.add(el)
  const commit = () => {
    patchSplitNodeViews(view, splitOf)
    if (widgetFrames.size > 0 || widgetFramesByView.has(view)) {
      if (widgetFrames.size > 0) widgetFramesByView.set(view, widgetFrames)
      else widgetFramesByView.delete(view)
      publishColumnFrames(view)
    }
    committedWrap.set(view, nextWrap)
  }
  if (batch) batch.then(commit)
  else commit()
  return changed
}

/**
 * Custom leaf NodeViews cannot host the split widget decoration. Maintain
 * their leading float after the editor updates its DOM.
 */
export function patchSplitNodeViews(view: EditorView, splitOf: Map<HTMLElement, string>): void {
  const obs = (view as unknown as { domObserver?: { stop(): void; start(): void } }).domObserver
  obs?.stop()
  try {
    // split floats the widget decoration could not place (atomic node views)
    for (const el of Array.from(
      view.dom.querySelectorAll<HTMLElement>(`[data-col-split-patch] > .${SPLIT_CLASS}`),
    ) as HTMLElement[]) {
      const host = el.parentElement as HTMLElement
      if (splitOf.get(host) === el.style.cssText) continue
      el.remove()
      host.removeAttribute('data-col-split-patch')
    }
    for (const [el, style] of splitOf) {
      if (el.querySelector(`:scope > .${SPLIT_CLASS}`)) continue
      el.setAttribute('data-col-split-patch', '1')
      el.insertBefore(splitFloatEl(el.ownerDocument, style), el.firstChild)
    }
  } finally {
    obs?.start()
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

function sameCols(a: DecorationSet, b: DecorationSet): boolean {
  const fa = a.find()
  const fb = b.find()
  if (fa.length !== fb.length) return false
  const sig = (d: Decoration) => `${d.from}-${d.to}-${(d.spec as { key?: string }).key ?? ''}`
  const sa = fa.map(sig).sort()
  const sb = fb.map(sig).sort()
  return sa.every((s, i) => s === sb[i])
}
