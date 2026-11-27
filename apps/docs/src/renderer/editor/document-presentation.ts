import type { Editor } from '@tiptap/core'
import { NodeSelection, type Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { revealDocumentRange } from './paged-view-probe'

type PositionBox = ReturnType<EditorView['coordsAtPos']>
type PointHit = ReturnType<EditorView['posAtCoords']>

/** All positions crossing the body presentation belong to the authored model. */
export interface DocumentPresentation {
  readonly dom: HTMLElement | undefined
  readonly editorView?: Partial<EditorView>
  focus(): void
  boundsAt(position: number): PositionBox | undefined
  hitTest(point: { left: number; top: number }): PointHit
  scrollTo(from: number, to: number): void
  select(selection: Selection, centerCaret: boolean): void
}

const mountedBodies = new WeakMap<Editor, DocumentPresentation>()

export function mountedDocumentPresentation(editor: Editor): DocumentPresentation | undefined {
  return mountedBodies.get(editor)
}

export function mountDocumentPresentation(editor: Editor, body: DocumentPresentation): () => void {
  mountedBodies.set(editor, body)
  return () => {
    if (mountedBodies.get(editor) === body) mountedBodies.delete(editor)
  }
}

export function documentPresentation(editor: Editor): DocumentPresentation {
  const mounted = mountedDocumentPresentation(editor)
  if (mounted) return mounted
  const { view } = editor
  // Tiptap retains model dispatch between mounts. Its unmounted view proxy
  // has no DOM methods during that interval.
  const dom = 'dom' in view ? view.dom : undefined
  const centerNode = (from: number) => {
    const { node } = view.domAtPos(from)
    const element = node instanceof HTMLElement ? node : node.parentElement
    element?.scrollIntoView({ block: 'center' })
  }
  return {
    dom,
    focus: () => {
      if (dom) view.focus()
    },
    boundsAt: (position) => (dom ? view.coordsAtPos(position, 1) : undefined),
    hitTest: (point) => (dom ? view.posAtCoords(point) : null),
    scrollTo(from, to) {
      if (!dom) return
      revealDocumentRange(view, from, to)
      centerNode(from)
    },
    select(selection, centerCaret) {
      const { from, to } = selection
      const transaction = editor.state.tr.setSelection(selection)
      if (!dom) {
        view.dispatch(transaction)
        return
      }
      revealDocumentRange(view, from, selection instanceof NodeSelection ? from : to)
      if (centerCaret) {
        view.dispatch(transaction)
        const pane = dom.closest('.editor-scroll')
        if (pane) {
          const caret = view.coordsAtPos(from, 1)
          const visible = pane.getBoundingClientRect()
          pane.scrollTop += (caret.top + caret.bottom - visible.top - visible.bottom) / 2
          return
        }
      } else view.dispatch(transaction.scrollIntoView())
      centerNode(from)
    },
  }
}
