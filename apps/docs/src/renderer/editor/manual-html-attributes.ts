import type { Attributes } from '@tiptap/core'

/** For extensions whose serializer reads model attrs and supplies all DOM
 * attributes itself. Skip Tiptap's unused HTMLAttributes merge. */
export function attributesRenderedManually(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, attribute]) => [
      name,
      { ...attribute, rendered: false },
    ]),
  )
}
