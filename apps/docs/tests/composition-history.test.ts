import { Editor, type Extensions } from '@tiptap/core'
import { expect, it } from 'vitest'
import { editorExtensions, textboxSubExtensions } from '../src/renderer/editor/extensions'

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6f1cAAAAASUVORK5CYII='

const makeEditor = (extensions: Extensions = editorExtensions) =>
  new Editor({
    element: document.createElement('div'),
    extensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          content: [
            { type: 'text', text: 'Before' },
            { type: 'docInlineImage', attrs: { dataUrl: png } },
          ],
        },
        { type: 'docParagraph', content: [{ type: 'text', text: 'After' }] },
      ],
    },
  })

function commitComposition(editor: Editor, at: number, text: string, id: number) {
  editor.commands.setTextSelection(at)
  editor.view.dispatch(
    editor.state.tr
      .insertText(text)
      .setTime(id * 1000)
      .setMeta('composition', id),
  )
}

function cancelComposition(editor: Editor, at: number, id: number) {
  const text = '候'
  commitComposition(editor, at, text, id)
  editor.view.dispatch(
    editor.state.tr
      .delete(at, at + text.length)
      .setTime(id * 1000 + 1)
      .setMeta('composition', id),
  )
}

it('undoes the prior committed composition in one action after a cancelled composition', () => {
  const editor = makeEditor()
  try {
    const original = editor.state.doc
    commitComposition(editor, 3, '测试', 1)
    const committed = editor.state.doc
    cancelComposition(editor, 5, 2)
    expect(editor.state.doc.eq(committed)).toBe(true)
    editor.commands.setTextSelection(2)

    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(original)).toBe(true)
    expect(editor.state.selection.from).toBe(3)

    expect(editor.commands.redo()).toBe(true)
    expect(editor.state.doc.eq(committed)).toBe(true)
    expect(editor.state.selection.from).toBe(2)
  } finally {
    editor.destroy()
  }
})

function pressUndo(editor: Editor) {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform)
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: !mac,
    metaKey: mac,
    bubbles: true,
    cancelable: true,
  })
  editor.view.dom.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

it('skips consecutive cancellations on textbox keyboard undo and toolbar redo', () => {
  const editor = makeEditor(textboxSubExtensions)
  try {
    const original = editor.state.doc
    commitComposition(editor, 3, '测试', 1)
    const firstEdit = editor.state.doc
    cancelComposition(editor, 5, 2)
    cancelComposition(editor, 6, 3)
    commitComposition(editor, 2, '二', 4)
    const secondEdit = editor.state.doc

    pressUndo(editor)
    expect(editor.state.doc.eq(firstEdit)).toBe(true)
    pressUndo(editor)
    expect(editor.state.doc.eq(original)).toBe(true)

    expect(editor.chain().focus().redo().run()).toBe(true)
    expect(editor.state.doc.eq(firstEdit)).toBe(true)
    expect(editor.chain().focus().redo().run()).toBe(true)
    expect(editor.state.doc.eq(secondEdit)).toBe(true)
  } finally {
    editor.destroy()
  }
})

it('consumes a cancellation-only history without changing document, selection or pending marks', () => {
  const editor = makeEditor()
  try {
    const original = editor.state.doc
    cancelComposition(editor, 3, 1)
    cancelComposition(editor, 4, 2)
    editor.commands.setTextSelection(2)
    const selection = editor.state.selection
    const marks = [editor.schema.marks.bold.create()]
    editor.view.dispatch(editor.state.tr.setStoredMarks(marks))

    expect(editor.commands.undo()).toBe(true)
    expect(editor.can().undo()).toBe(false)
    expect(editor.commands.redo()).toBe(true)
    expect(editor.can().redo()).toBe(false)
    expect(editor.state.doc.eq(original)).toBe(true)
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(editor.state.storedMarks).toEqual(marks)
  } finally {
    editor.destroy()
  }
})
