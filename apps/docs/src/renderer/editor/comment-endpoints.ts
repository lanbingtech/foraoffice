import { Extension } from '@tiptap/core'
import type { Fragment } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { AnchorBlock } from './margin-annotations'
import { appendedStreamedTail } from './streaming-tail-guard'

interface Endpoints {
  source?: AnchorBlock[]
  positions: Map<string, number>
}

const key = new PluginKey<Endpoints>('commentEndpoints')

function resolveEndpoints(content: Fragment, positions: Map<string, number>, start = 0): void {
  content.descendants((node, pos) => {
    if (!node.isTextblock) return
    const offsets = node.attrs.commentEndOffsets as Record<string, number> | null
    if (offsets) {
      for (const [id, offset] of Object.entries(offsets)) {
        if (!positions.has(id)) positions.set(id, start + pos + 1 + offset)
      }
    }
    // An empty paragraph has no run to carry boundary metadata. Its only
    // possible text endpoint is its content start, exactly offset zero.
    if (node.content.size === 0) {
      for (const id of (node.attrs.commentEnds as string[] | null) ?? []) {
        if (!positions.has(id)) positions.set(id, start + pos + 1)
      }
    }
  })
}

/** End offsets come from the actual Run-to-inline conversion. Transactions
 * then move screen-only positions without altering saved document markers. */
export const CommentEndpointsExtension = Extension.create({
  name: 'commentEndpoints',
  addProseMirrorPlugins() {
    return [
      new Plugin<Endpoints>({
        key,
        state: {
          init: (_, state) => {
            const positions = new Map<string, number>()
            resolveEndpoints(state.doc.content, positions)
            return { positions }
          },
          apply(tr, previous) {
            const seeded = tr.getMeta(key) as Endpoints | undefined
            if (seeded) return seeded
            if (!tr.docChanged) return previous
            const tail = appendedStreamedTail(tr)
            if (tail) {
              const positions = new Map(previous.positions)
              resolveEndpoints(tail.content, positions, tail.from)
              return positions.size === previous.positions.size
                ? previous
                : { ...previous, positions }
            }
            const positions = new Map(
              [...previous.positions].map(([id, pos]) => [id, tr.mapping.map(pos, -1)]),
            )
            resolveEndpoints(tr.doc.content, positions)
            return { ...previous, positions }
          },
        },
      }),
    ]
  },
})

/** Reset on document replacement; layout refreshes retain mapped positions. */
export function commentEndpoints(
  view: EditorView,
  source: AnchorBlock[] | undefined,
): Map<string, number> {
  const previous = key.getState(view.state)
  if (!previous || previous.source === source) return previous?.positions ?? new Map()
  const positions = new Map<string, number>()
  resolveEndpoints(view.state.doc.content, positions)
  view.dispatch(view.state.tr.setMeta(key, { source, positions }).setMeta('addToHistory', false))
  return positions
}
