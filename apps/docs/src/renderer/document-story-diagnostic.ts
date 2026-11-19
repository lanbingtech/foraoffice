import type { Block } from '@genoffice/docx-engine'

/** Internal, lazy fidelity diagnostics. No editing or scheduling code consumes this data. */
export function createDocumentStoryDiagnostic(
  current: () => {
    documentGeneration: number
    layoutGeneration: number
    document: { hash: string; blocks: readonly Block[] } | null
  },
) {
  return {
    snapshot() {
      const state = current()
      return {
        version: 1,
        documentGeneration: state.documentGeneration,
        layoutGeneration: state.layoutGeneration,
        documentHash: state.document?.hash ?? null,
        blocks: (state.document?.blocks ?? []).flatMap((block) =>
          block.textboxes?.length || block.type === 'table'
            ? [
                {
                  docxIndex: block.docxIndex,
                  originalXml: block.originalXml,
                  textboxes: (block.textboxes ?? []).map((box) => ({
                    ...(box.txbxIndex !== undefined ? { txbxIndex: box.txbxIndex } : {}),
                    ...(box.shapeId !== undefined ? { shapeId: box.shapeId } : {}),
                    ...(box.readOnly !== undefined ? { readOnly: box.readOnly } : {}),
                  })),
                },
              ]
            : [],
        ),
      }
    },
  }
}
