import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/** Native composition follows the input surface, even when the source has no DOM. */
export const sourceCompositionKey = new PluginKey<symbol | null>('sourceComposition')
export const SOURCE_DOCUMENT_REPLACED = 'document-replaced'

export const sourceCompositionPlugin = new Plugin<symbol | null>({
  key: sourceCompositionKey,
  state: {
    init: () => null,
    apply(transaction, previous) {
      const session = transaction.getMeta(sourceCompositionKey) as
        symbol | typeof SOURCE_DOCUMENT_REPLACED | null | undefined
      if (session === undefined) return previous
      return session === SOURCE_DOCUMENT_REPLACED ? null : session
    },
  },
})

export const SourceCompositionExtension = Extension.create({
  name: 'sourceComposition',
  addProseMirrorPlugins() {
    return [sourceCompositionPlugin]
  },
})
