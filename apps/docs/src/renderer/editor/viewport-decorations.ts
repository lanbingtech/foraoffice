import { Decoration, type EditorView } from '@tiptap/pm/view'
import { columnSplitDecoration, patchSplitNodeViews } from './column-layout'
import { makeGapEl, viewportFlowGap, type ViewportFlowGap } from './pagination-gaps'
import type { EditingViewport, ViewportModelBlock } from './viewport-editing'

type DecorationSpan = {
  from: number
  to: number
  through: number
} & (
  | { attrs: Record<string, string>; inline: boolean }
  | { columnSplit: string; direct: boolean }
  | { flowGap: ViewportFlowGap }
)

export type ViewportDecorations = readonly DecorationSpan[]

type DecoratedRange = Decoration & {
  readonly type: { attrs?: Record<string, string> }
}

/** Keep measured styles independent of the projected editor's own view. */
export function readViewportDecorations(view: EditorView): ViewportDecorations {
  const spans: DecorationSpan[] = []
  view.someProp('decorations', (provider) => {
    provider(view.state)?.forEachSet((set) => {
      const picked = set.find(
        undefined,
        undefined,
        (spec) =>
          spec.paintInViewport === true ||
          spec.paintInViewport === 'inline' ||
          (spec.gapKind !== undefined && spec.gapKind !== 'block') ||
          typeof spec.viewportColumnSplit === 'string',
      )
      for (const raw of picked) {
        const { from, to, type, spec } = raw as DecoratedRange
        if (spec.gapKind !== undefined) {
          const flowGap = viewportFlowGap(spec)
          if (flowGap) spans.push({ from, to, flowGap, through: to })
          continue
        }
        if (typeof spec.viewportColumnSplit === 'string') {
          // Index the leading float by its owning block, including a leaf
          // whose widget position is the end of the visible range.
          const owner = view.nodeDOM(from - 1)
          spans.push({
            from: from - 1,
            to,
            columnSplit: spec.viewportColumnSplit,
            direct: owner instanceof HTMLElement && owner.dataset.colSplitPatch === '1',
            through: to,
          })
          continue
        }
        const { class: classes, style } = spec.frame ?? type.attrs ?? {}
        if (!classes && !style) continue
        spans.push({
          from,
          to,
          attrs: { ...(classes ? { class: classes } : {}), ...(style ? { style } : {}) },
          inline: spec.paintInViewport === 'inline',
          through: to,
        })
      }
    })
  })
  spans.sort((a, b) => a.from - b.from)
  for (let i = 1; i < spans.length; i++)
    spans[i].through = Math.max(spans[i].through, spans[i - 1].through)
  return spans
}

export function viewDecorationWindow(
  decorations: ViewportDecorations,
  from: number,
  to: number,
): ViewportDecorations {
  let low = 0
  let high = decorations.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (decorations[middle].through > from) high = middle
    else low = middle + 1
  }
  const picked: DecorationSpan[] = []
  for (let i = low; i < decorations.length; i++) {
    const span = decorations[i]
    if (span.from >= to) break
    if (span.to > from) picked.push(span)
  }
  return picked
}

export function projectViewportDecorations(
  decorations: ViewportDecorations,
  editing: EditingViewport,
  blocks: readonly ViewportModelBlock[],
): Decoration[] {
  const result: Decoration[] = []
  if (decorations.length === 0) return result
  const clipped = new Map<number, { to: number; localFrom: number; localTo: number }>()
  editing.doc.forEach((node, localFrom, index) => {
    const block = blocks[index]
    if (block.pictures)
      clipped.set(block.from, { to: block.to, localFrom, localTo: localFrom + node.nodeSize })
  })
  for (const span of decorations) {
    const from = editing.toLocal(span.from)
    if ('flowGap' in span) {
      if (from === undefined || from <= 0 || from >= editing.doc.content.size) continue
      // Absolutely positioned picture fragments already include page breaks
      // in their placements. Their paragraph has no text flow to carry a gap.
      const pictureParagraph = blocks.find(
        (block) => block.pictures && block.from < span.from && span.from < block.to,
      )
      if (!pictureParagraph) {
        const { kind, metrics, cols, pullUp } = span.flowGap
        result.push(
          Decoration.widget(from, () => makeGapEl(metrics, kind, cols, pullUp), {
            side: -1,
            key: `viewport-flow-gap-${span.from}-${JSON.stringify(span.flowGap)}`,
          }),
        )
      }
      continue
    }
    if ('columnSplit' in span) {
      if (from !== undefined && !span.direct)
        result.push(columnSplitDecoration(from + 1, span.columnSplit))
      continue
    }
    const to = editing.toLocal(span.to)
    if (span.inline) {
      if (from !== undefined && to !== undefined && from < to)
        result.push(Decoration.inline(from, to, span.attrs))
      continue
    }
    if (from !== undefined && to !== undefined && from < to) {
      result.push(Decoration.node(from, to, span.attrs))
    } else {
      const paragraph = clipped.get(span.from)
      if (paragraph?.to === span.to)
        result.push(Decoration.node(paragraph.localFrom, paragraph.localTo, span.attrs))
    }
  }
  return result
}

/** Leaf NodeViews have no contentDOM in which to place the leading float. */
export function positionViewportColumnSplits(
  view: EditorView,
  decorations: ViewportDecorations,
  editing: EditingViewport,
): void {
  const targets = new Map<HTMLElement, string>()
  for (const span of decorations) {
    if (!('columnSplit' in span)) continue
    const position = editing.toLocal(span.from)
    if (position === undefined) continue
    const node = view.nodeDOM(position)
    if (node instanceof HTMLElement) targets.set(node, span.columnSplit)
  }
  if (targets.size > 0 || view.dom.querySelector('[data-col-split-patch]'))
    patchSplitNodeViews(view, targets)
}
