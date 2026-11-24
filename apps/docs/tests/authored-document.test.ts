// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { closeHistory, redoNoScroll, undoNoScroll } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import type { Command, EditorState, Transaction } from '@tiptap/pm/state'
import { Step } from '@tiptap/pm/transform'
import { describe, expect, it, vi } from 'vitest'
import {
  AuthoredDocument,
  layoutReplicaPlugins,
  LAYOUT_REPLAY,
} from '../src/renderer/editor/authored-document'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { sourceCompositionKey } from '../src/renderer/editor/source-composition'

const history = (command: Command) => (state: EditorState) => {
  let transaction: Transaction | undefined
  command(state, (value) => (transaction = value))
  if (!transaction) throw new Error('History did not provide a transaction')
  return transaction
}

describe('the authored document with the real Docs extensions', () => {
  it.each([false, true])('preserves editing and history with Track Changes %s', (tracked) => {
    vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
    const editor = new Editor({
      extensions: editorExtensions,
      element: document.createElement('div'),
      content: {
        type: 'doc',
        content: [
          { type: 'docParagraph', content: [{ type: 'text', text: '首段' }] },
          { type: 'docParagraph', content: [{ type: 'text', text: '正文' }] },
        ],
      },
    })
    const authored = new Editor({ extensions: editorExtensions, element: null })
    try {
      editor.storage.trackChanges.enabled = tracked
      authored.storage.trackChanges.enabled = tracked
      let original = editor.state
      const owner = new AuthoredDocument(
        authored,
        authored.schema.nodeFromJSON(original.doc.toJSON()),
        () => {},
      )
      expect(original.plugins.length - owner.read().state.plugins.length).toBe(17)

      const compare = (build: (state: EditorState) => Transaction) => {
        const expected = original.applyTransaction(build(original))
        original = expected.state
        const accepted = owner.dispatch(build(owner.read().state))
        const actual = owner.read().state
        expect(actual.doc.toJSON()).toEqual(original.doc.toJSON())
        expect(actual.selection.toJSON()).toEqual(original.selection.toJSON())
        expect(accepted).toHaveLength(expected.transactions.length)
      }
      compare((state) => closeHistory(state.tr.insertText('你', 2)))
      expect(owner.read().state.doc.textContent).toContain('首你段')
      compare(history(undoNoScroll))
      expect(owner.read().state.doc.textContent).toBe('首段正文')
      compare(history(redoNoScroll))
      expect(owner.read().state.doc.textContent).toContain('首你段')
      expect(owner.read().revision).toBe(3)
    } finally {
      editor.destroy()
      authored.destroy()
      vi.useRealTimers()
    }
  })

  it('keeps the real undo after a canceled composition in the same authored revision', () => {
    const editor = new Editor({ extensions: editorExtensions, element: null })
    const original = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: '正文' }] }],
    })
    const publish = vi.fn()
    const owner = new AuthoredDocument(editor, original, publish)
    try {
      const read = () => owner.read().state
      owner.dispatch(read().tr.insertText('你', 2).setTime(1000).setMeta('composition', 1))
      owner.dispatch(read().tr.insertText('临', 3).setTime(2000).setMeta('composition', 2))
      owner.dispatch(read().tr.delete(3, 4).setTime(2001).setMeta('composition', 2))
      expect(read().doc.textContent).toBe('正你文')
      owner.dispatch(history(undoNoScroll)(read()))
      expect(read().doc.eq(original)).toBe(true)
      expect(owner.read().revision).toBe(4)
      expect(publish.mock.calls.at(-1)?.[0]).toHaveLength(2)
    } finally {
      owner.destroy()
    }
  })

  it('preserves the paragraph format when deleting the whole text selection', () => {
    const editor = new Editor({ extensions: editorExtensions, element: null })
    const original = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { styleId: 'Heading2' },
          content: [{ type: 'text', text: '正文' }],
        },
      ],
    })
    const owner = new AuthoredDocument(editor, original, () => {})
    try {
      const state = owner.read().state
      owner.dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)))
      owner.dispatch(owner.read().state.tr.deleteSelection())
      const actual = owner.read().state.doc.firstChild!
      expect(actual.textContent).toBe('')
      expect(actual.attrs.styleId).toBe('Heading2')
    } finally {
      owner.destroy()
    }
  })

  it('waits for the source composition to commit before detecting paragraph direction', () => {
    const editor = new Editor({ extensions: editorExtensions, element: null })
    const original = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'docParagraph' }],
    })
    const owner = new AuthoredDocument(editor, original, () => {})
    try {
      const read = () => owner.read().state
      owner.dispatch(read().tr.setMeta(sourceCompositionKey, Symbol()))
      owner.dispatch(read().tr.insertText('א', 1).setMeta('composition', 1))
      expect(read().doc.firstChild?.attrs.bidi).not.toBe(true)
      owner.dispatch(read().tr.setMeta(sourceCompositionKey, null))
      expect(read().doc.firstChild?.attrs.bidi).toBe(true)
      expect(read().doc.textContent).toBe('א')
    } finally {
      owner.destroy()
    }
  })

  it('preserves an explicit direction when a structural edit occurs during composition', () => {
    const editor = new Editor({ extensions: editorExtensions, element: null })
    const original = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'docParagraph' }],
    })
    const owner = new AuthoredDocument(editor, original, () => {})
    try {
      const read = () => owner.read().state
      owner.dispatch(read().tr.setMeta(sourceCompositionKey, Symbol()))
      const paragraph = editor.schema.nodes.docParagraph.create(
        { bidi: false },
        editor.schema.text('א'),
      )
      const replace = read().tr.replaceWith(0, original.content.size, paragraph)
      owner.dispatch(replace.setSelection(TextSelection.create(replace.doc, 2)))
      owner.dispatch(read().tr.setMeta(sourceCompositionKey, null))
      expect(read().doc.firstChild?.attrs.bidi).toBe(false)
      expect(read().doc.textContent).toBe('א')
    } finally {
      owner.destroy()
    }
  })

  it('accepts an authored undo that leaves a final table without adding another paragraph', () => {
    const editor = new Editor({
      extensions: editorExtensions,
      element: document.createElement('div'),
      content: {
        type: 'doc',
        content: [
          {
            type: 'docTable',
            content: [
              {
                type: 'docTableRow',
                content: [{ type: 'docTableCell', content: [{ type: 'docParagraph' }] }],
              },
            ],
          },
        ],
      },
    })
    try {
      const original = editor.state
      const withParagraph = original.apply(
        original.tr.insert(original.doc.content.size, original.schema.nodes.docParagraph.create()),
      )
      const undo = history(undoNoScroll)(withParagraph)
      expect(withParagraph.apply(undo).doc.eq(original.doc)).toBe(true)
      const replay = (state: EditorState) => {
        const tr = state.tr.setMeta(LAYOUT_REPLAY, true)
        for (const step of undo.steps) tr.step(Step.fromJSON(state.schema, step.toJSON()))
        return state.apply(tr).doc
      }
      expect(replay(withParagraph).eq(original.doc)).toBe(false)
      const replica = withParagraph.reconfigure({
        plugins: layoutReplicaPlugins(withParagraph.plugins),
      })
      expect(replay(replica).eq(original.doc)).toBe(true)
    } finally {
      editor.destroy()
    }
  })
})
