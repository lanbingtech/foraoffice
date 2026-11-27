import type { Node as PmNode } from '@tiptap/pm/model'
import { BlockIndex } from '../pagination-index'
import { rowSplitFragmentsOf } from '../pagination-slices'
import type { BlockBox, PageColumn, PageSlice, RowSplitPatch } from '../pagination-types'

export interface TableCellBoundaryReader {
  read(block: BlockBox, row: number, cell: number, lines: readonly number[]): number[] | undefined
}

export interface ViewportTableRowFragment {
  cutIndex: number
  regionIndex?: number
  columnIndex?: number
  tablePosition: number
  rowIndex: number
  from: number
  to: number
  cells: readonly { from: number; to: number }[]
}

export function rebaseViewportTableFragments(
  source: PmNode,
  target: PmNode,
  fragments: readonly ViewportTableRowFragment[],
): readonly ViewportTableRowFragment[] | undefined {
  if (source === target || fragments.length === 0) return fragments
  const start = source.content.findDiffStart(target.content)
  if (start === null) return fragments
  const end = source.content.findDiffEnd(target.content)
  if (!end || end.a < start || end.b < start) return
  const shifts = new Map<number, number>()
  for (const { tablePosition } of fragments) {
    if (shifts.has(tablePosition)) continue
    const table = source.nodeAt(tablePosition)
    if (!table || table.type.name !== 'docTable') return
    const changeAfterTable = tablePosition + table.nodeSize <= start
    if (!changeAfterTable && tablePosition < end.a) return
    const shift = changeAfterTable ? 0 : end.b - end.a
    if (target.nodeAt(tablePosition + shift) !== table) return
    shifts.set(tablePosition, shift)
  }
  return fragments.map((fragment) => {
    const shift = shifts.get(fragment.tablePosition)!
    if (shift === 0) return fragment
    return {
      ...fragment,
      tablePosition: fragment.tablePosition + shift,
      cells: fragment.cells.map(({ from, to }) => ({ from: from + shift, to: to + shift })),
    }
  })
}

function owningTablePosition(source: PmNode, position: number, row: number, cell: number) {
  if (!Number.isInteger(position) || position < 0 || position > source.content.size) return
  const resolved = source.resolve(position)
  if (
    resolved.depth < 3 ||
    resolved.node(1).type.name !== 'docTable' ||
    resolved.node(2).type.name !== 'docTableRow' ||
    !['docTableCell', 'docTableHeader'].includes(resolved.node(3).type.name) ||
    resolved.index(1) !== row ||
    resolved.index(2) !== cell
  )
    return
  return resolved.before(1)
}

/** Resolve only the lines selected by the current layout, before its DOM is changed. */
export function collectViewportTableFragments(
  source: PmNode,
  blocks: BlockBox[],
  slices: PageSlice[],
  patches: readonly RowSplitPatch[],
  boundaries: TableCellBoundaryReader,
): ViewportTableRowFragment[] {
  if (patches.length === 0) return []
  const windows = new Map<
    PageSlice | PageColumn,
    Pick<ViewportTableRowFragment, 'cutIndex' | 'regionIndex' | 'columnIndex'>
  >()
  slices.forEach((slice, cutIndex) => {
    windows.set(slice, { cutIndex })
    slice.regions?.forEach((region, regionIndex) => {
      region.columns.forEach((column, columnIndex) => {
        windows.set(column, { cutIndex, regionIndex, columnIndex })
      })
    })
  })
  const index = new BlockIndex(blocks)
  const published: ViewportTableRowFragment[] = []
  for (const patch of patches) {
    const fragments = rowSplitFragmentsOf(patch)
    if (!fragments?.length || fragments.some((fragment) => !windows.has(fragment.window))) continue
    let matches = 0
    const block =
      blocks[
        index.firstAtTop(patch.blockTop, (entry) => {
          if (!entry.tableRows?.[patch.row]?.cells) return false
          matches++
          return true
        })
      ]
    if (matches !== 1 || !block) continue

    const cells = block.tableRows![patch.row].cells!
    if (fragments.some((fragment) => fragment.cells.length !== cells.length)) continue
    const positions: Array<Map<number, number>> = []
    let tablePosition: number | undefined
    for (let cell = 0; cell < cells.length; cell++) {
      const lines = [...new Set(fragments.flatMap((fragment) => fragment.cells[cell]))].sort(
        (a, b) => a - b,
      )
      const resolved = boundaries.read(block, patch.row, cell, lines)
      if (!resolved || resolved.length !== lines.length) break
      const owner = owningTablePosition(source, resolved[0], patch.row, cell)
      if (
        owner === undefined ||
        (tablePosition !== undefined && tablePosition !== owner) ||
        resolved.some(
          (position, i) =>
            (i > 0 && position <= resolved[i - 1]) ||
            owningTablePosition(source, position, patch.row, cell) !== owner,
        )
      )
        break
      tablePosition = owner
      positions.push(new Map(lines.map((line, i) => [line, resolved[i]])))
    }
    if (positions.length !== cells.length || tablePosition === undefined) continue
    for (const { window, from, to, cells: lineRanges } of fragments) {
      published.push({
        ...windows.get(window)!,
        tablePosition,
        rowIndex: patch.row,
        from,
        to,
        cells: lineRanges.map(([start, end], cell) => ({
          from: positions[cell].get(start)!,
          to: positions[cell].get(end)!,
        })),
      })
    }
  }
  return published
}
