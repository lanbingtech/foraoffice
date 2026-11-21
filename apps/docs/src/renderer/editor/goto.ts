/**
 * Word's Edit ▸ Go To: resolve a target (page, section, line, bookmark, comment,
 * note, table, heading) to a document position. Document-structure targets are
 * read from the ProseMirror doc; page / section / line targets need the last
 * pagination pass (`PageLayout`), which App feeds through a ref.
 */
import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { BlockIndex } from '../pagination-index'
import type { FlowCarry, PageCut } from '../pagination-cuts'
import { sliceStartsVisiblePage } from '../pagination-slices'
import { nextLineAnchor, outerTableRows } from '../pagination-lines'
import { pageGapPositions } from './pagination-gaps'
import { measureNatural } from './settled-measure'
import type {
  BlockBox,
  PageSlice,
  RowSplitPatch,
  SectionGeom,
  SectionHfHeights,
} from '../pagination-types'

export type GoToTarget =
  | 'page'
  | 'section'
  | 'line'
  | 'bookmark'
  | 'comment'
  | 'footnote'
  | 'endnote'
  | 'table'
  | 'heading'

export const GOTO_TARGETS: readonly GoToTarget[] = [
  'page',
  'section',
  'line',
  'bookmark',
  'comment',
  'footnote',
  'endnote',
  'table',
  'heading',
]

export interface GoToItem {
  pos: number
  label: string
}

export interface PageLayout {
  blocks: BlockBox[]
  slices: PageSlice[]
  sections: Array<{ firstBlockIndex: number }>
  /** the pass's PageCut list (one per slice), geometry and row splits: what the preview sheets print */
  cuts: PageCut[]
  geoms: SectionGeom[]
  hfHeights: SectionHfHeights[]
  rowSplits: RowSplitPatch[]
  /** 1-based page at an editor screen Y, using the same boundaries as the status bar. */
  pageAtScreenY?: (y: number) => number
  /** float-carry spacers of split floating tables (flow displacement, flowOffsetAt) */
  carries: FlowCarry[]
}

/** structural targets in document order (bookmarks carry their name as label) */
export function listGoToItems(doc: PmNode, target: GoToTarget): GoToItem[] {
  const items: GoToItem[] = []
  const seenComments = new Set<string>()
  doc.descendants((node, pos) => {
    switch (target) {
      case 'heading':
        if (node.type.name === 'docHeading')
          items.push({ pos, label: node.textContent.slice(0, 60) })
        return true
      case 'table':
        if (node.type.name === 'docTable') {
          items.push({ pos, label: node.textContent.slice(0, 60) })
          return false
        }
        return true
      case 'footnote':
      case 'endnote':
        if (node.type.name === 'docNoteRef' && node.attrs.kind === target)
          items.push({ pos, label: String(node.attrs.num ?? '') })
        return true
      case 'bookmark': {
        const names = node.attrs?.bookmarks as string[] | null | undefined
        if (Array.isArray(names)) for (const name of names) items.push({ pos, label: name })
        return true
      }
      case 'comment': {
        if (!node.isText) return true
        for (const mark of node.marks) {
          if (mark.type.name !== 'comment') continue
          for (const id of String(mark.attrs.ids ?? '').split(' ')) {
            if (!id || seenComments.has(id)) continue
            seenComments.add(id)
            items.push({ pos, label: node.text?.slice(0, 60) ?? '' })
          }
        }
        return true
      }
      default:
        return false
    }
  })
  return items
}

const blockPos = (view: EditorView, block: BlockBox | undefined): number | null => {
  if (!block?.el || !view.dom.contains(block.el)) return null
  try {
    return view.posAtDOM(block.el, 0)
  } catch {
    return null
  }
}

/** index of the block whose DOM element contains `pos`, or -1 */
export function blockIndexAtPos(view: EditorView, layout: PageLayout, pos: number): number {
  let node: Node | null
  try {
    node = view.domAtPos(pos).node
  } catch {
    return -1
  }
  return layout.blocks.findIndex((b) => b.el && b.el.contains(node))
}

export function pagePositions(view: EditorView, layout: PageLayout): Array<number | null> {
  const { blocks, slices, cuts } = layout
  const gaps = pageGapPositions(view.state)
  const index = new BlockIndex(blocks)
  const positions: Array<number | null> = []
  slices.forEach((slice, i) => {
    if (!sliceStartsVisiblePage(slice, slices[i - 1])) return
    const lead = cuts[i]?.lead
    const anchored = gaps.get(i)
    if (slice.end === slice.start && i < slices.length - 1) positions.push(null)
    else if (anchored !== undefined) positions.push(anchored)
    else if (lead?.kind === 'tail') positions.push(view.state.doc.content.size)
    else if (lead?.kind === 'block') positions.push(blockPos(view, blocks[lead.block]))
    else if (lead && i > 0) positions.push(null)
    else positions.push(blockPos(view, blocks[i === 0 ? 0 : index.firstAtTop(slice.start)]))
  })
  return positions
}

/** A page can start within a block even in a view that draws no page-gap widgets. */
export function pagePositionWithoutGap(
  view: EditorView,
  layout: PageLayout,
  page: number,
): number | null {
  const index = layout.slices.findIndex((slice, i) => {
    if (sliceStartsVisiblePage(slice, layout.slices[i - 1])) page--
    return page < 0
  })
  const lead = layout.cuts[index]?.lead
  if (!lead || layout.cuts[index].blank) return null
  const el = layout.blocks[lead.block]?.el
  if (!el || !view.dom.contains(el)) return null
  if (lead.kind === 'row') {
    const row = outerTableRows(el)[lead.row ?? -1]
    return row ? view.posAtDOM(row, 0) : null
  }
  if (lead.kind !== 'line' && lead.kind !== 'cell') return null
  const zoom = el.getBoundingClientRect().width / el.offsetWidth
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const anchor = measureNatural(el, () => nextLineAnchor(el, lead.lineOffset ?? 0, zoom))
  if (!anchor) return null
  const host = anchor.node instanceof Element ? anchor.node : anchor.node.parentElement
  if (host?.closest('.doc-nested-table')) return null
  return view.posAtDOM(anchor.node, anchor.charOffset)
}

export function sectionPositions(view: EditorView, layout: PageLayout): Array<number | null> {
  return layout.sections.map((s) => {
    const block =
      layout.blocks.find((b) => b.docxIndex === s.firstBlockIndex) ??
      layout.blocks[Math.min(s.firstBlockIndex, layout.blocks.length - 1)]
    return blockPos(view, block)
  })
}

/** cumulative measured lines per block (a block without line boxes counts as one line) */
export function lineCounts(layout: PageLayout): number[] {
  return layout.blocks.map((b) => Math.max(1, b.lineBoxes?.length ?? 1))
}

/** index of the line box containing a vertical offset inside the block (clamped) */
export function lineAtOffset(
  lineBoxes: Array<{ offsetInBlock: number; height: number }> | undefined,
  offsetInBlock: number,
): number {
  if (!lineBoxes || lineBoxes.length === 0) return 0
  let idx = 0
  for (let i = 0; i < lineBoxes.length; i++) {
    if (offsetInBlock >= lineBoxes[i].offsetInBlock) idx = i
  }
  return idx
}

/** 0-based document line under the caret: lines of the blocks before it plus its line within the block */
export function lineIndexAtPos(view: EditorView, layout: PageLayout, pos: number): number {
  const bi = blockIndexAtPos(view, layout, pos)
  if (bi < 0) return 0
  const counts = lineCounts(layout)
  const before = counts.slice(0, bi).reduce((a, b) => a + b, 0)
  const block = layout.blocks[bi]
  if (!block.el || block.height <= 0) return before
  let caretTop: number
  try {
    const c = view.coordsAtPos(pos)
    caretTop = (c.top + c.bottom) / 2
  } catch {
    return before
  }
  const rect = block.el.getBoundingClientRect()
  const zoom = rect.height / block.height
  return before + lineAtOffset(block.lineBoxes, (caretTop - rect.top) / zoom)
}

/** document position of the 1-based `line`, via the block's DOM box and the line's offset */
export function linePosition(view: EditorView, layout: PageLayout, line: number): number | null {
  const counts = lineCounts(layout)
  let acc = 0
  for (let i = 0; i < counts.length; i++) {
    if (line <= acc + counts[i]) {
      const block = layout.blocks[i]
      const start = blockPos(view, block)
      if (start === null || !block.el) return null
      const box = block.lineBoxes?.[line - acc - 1]
      if (!box || block.height <= 0) return start
      const rect = block.el.getBoundingClientRect()
      const zoom = rect.height / block.height
      const hit = view.posAtCoords({
        left: rect.left + 2,
        top: rect.top + (box.offsetInBlock + box.height / 2) * zoom,
      })
      return hit ? hit.pos : start
    }
    acc += counts[i]
  }
  return null
}

/**
 * Word's Go To input: a plain number is absolute (1-based), `+N` / `-N` move
 * from `current`; empty means "next". Returns the 0-based index into `count`
 * items, clamped, or null when nothing parses.
 */
export function resolveGoToIndex(
  input: string,
  current: number,
  count: number,
  dir: 1 | -1 = 1,
): number | null {
  if (count <= 0) return null
  const s = input.trim()
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i))
  if (!s) return clamp(current + dir)
  const rel = /^([+-])(\d+)$/.exec(s)
  if (rel) return clamp(current + (rel[1] === '+' ? 1 : -1) * Number(rel[2]))
  if (/^\d+$/.test(s)) return clamp(Number(s) - 1)
  return null
}
