import { Extension } from '@tiptap/core'
import type { Node, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Mapping } from '@tiptap/pm/transform'

interface SourceComposition {
  token: symbol
  before: Node
  mapping: Mapping
  inserted: 'none' | 'text' | 'structure'
}

export function insertedContent(
  transactions: readonly Transaction[],
): SourceComposition['inserted'] {
  let inserted: SourceComposition['inserted'] = 'none'
  for (const transaction of transactions) {
    for (const step of transaction.steps) {
      const content = (step as { slice?: Slice }).slice?.content
      if (!content?.childCount) continue
      for (let i = 0; i < content.childCount; i++) {
        if (!content.child(i).isText) return 'structure'
      }
      inserted = 'text'
    }
  }
  return inserted
}

/** Native composition follows the input surface, even when the source has no DOM. */
export const sourceCompositionKey = new PluginKey<SourceComposition | null>('sourceComposition')
export const SOURCE_DOCUMENT_REPLACED = 'document-replaced'

export const sourceCompositionPlugin = new Plugin<SourceComposition | null>({
  key: sourceCompositionKey,
  state: {
    init: () => null,
    apply(transaction, previous) {
      const session = transaction.getMeta(sourceCompositionKey) as
        symbol | typeof SOURCE_DOCUMENT_REPLACED | null | undefined
      if (session === SOURCE_DOCUMENT_REPLACED || session === null) return null
      if (session !== undefined)
        return {
          token: session,
          before: transaction.before,
          mapping: new Mapping(),
          inserted: 'none',
        }
      if (!previous || !transaction.docChanged) return previous
      const mapping = new Mapping()
      mapping.appendMapping(previous.mapping)
      mapping.appendMapping(transaction.mapping)
      const next = insertedContent([transaction])
      const inserted =
        previous.inserted === 'structure' || next === 'none' ? previous.inserted : next
      return { ...previous, mapping, inserted }
    },
  },
})

export const SourceCompositionExtension = Extension.create({
  name: 'sourceComposition',
  addProseMirrorPlugins() {
    return [sourceCompositionPlugin]
  },
})
