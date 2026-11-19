import type { EditorView } from '@tiptap/pm/view'
import type { TableCell } from '@genoffice/docx-engine'
import type { BlockBox, RowSplitPatch } from './pagination-types'

/** Passive preview source/clip evidence, evaluated only when explicitly requested. */
export function createPrintSourceDiagnostic(
  view: EditorView,
  blocks: Array<Pick<BlockBox, 'top' | 'height' | 'docxIndex'>>,
  rowSplits: RowSplitPatch[],
) {
  const document = view.state.doc
  return () => ({
    version: 1,
    modelCurrent: !view.isDestroyed && view.state.doc === document,
    blocks: blocks.map(({ top, height, docxIndex }) => ({ top, height, docxIndex })),
    rowSplits: rowSplits.map((split) => ({
      ...split,
      rules: split.rules.map((rule) => ({ ...rule })),
    })),
    tables: document.content.content.flatMap((node) =>
      node.type.name === 'docTable'
        ? [
            {
              docxIndex: node.attrs.docxIndex as number | null,
              sourceTable: node.attrs.sourceTable as string | null,
              rows: node.content.content.map((row, rowIndex) => ({
                rowIndex,
                sourceRow: row.attrs.sourceRow
                  ? ({ ...row.attrs.sourceRow } as { table: string; row: number })
                  : null,
                repeatHeader: row.attrs.repeatHeader === true,
                cells: row.content.content.map((cell, cellIndex) => ({
                  cellIndex,
                  sourceCell: cell.attrs.sourceCell
                    ? ({ ...cell.attrs.sourceCell } as TableCell['sourceCell'])
                    : null,
                  gridGap: cell.attrs.gridGap === true,
                  colspan: cell.attrs.colspan as number,
                  rowspan: cell.attrs.rowspan as number,
                })),
              })),
            },
          ]
        : [],
    ),
  })
}
