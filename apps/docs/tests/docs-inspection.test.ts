import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsInspection } from '../src/renderer/sdk/inspection'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
function fixture() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>same <b>sa</b>me same</p>',
  })
  editors.push(editor)
  let identity = {}
  const api = createDocsInspection(() => ({ editor, identity }))
  return {
    editor,
    api,
    switchDocument: () => {
      identity = {}
    },
  }
}

it('finds native cross-format matches and locates every occurrence without a document edit', () => {
  const { api, editor } = fixture()
  const result = api.find('same')
  expect(result.matches).toHaveLength(3)
  const before = editor.getJSON()
  editor.setEditable(false)
  for (const match of result.matches) {
    api.locate(match)
    expect(editor.state.selection.from).toBe(match.from)
    expect(editor.state.selection.to).toBe(match.to)
  }
  expect(editor.getJSON()).toEqual(before)
  expect(() => api.replace(result, 'other')).toThrow(/read.only/i)
})

it('uses native replacement expressions over original matches in a single undoable transaction', () => {
  const { api, editor } = fixture()
  const found = api.find('(same)', { mode: 'regex' })
  expect(api.replace(found, '$1!')).toBe(3)
  expect(editor.getText()).toBe('same! same! same!')
  editor.commands.undo()
  expect(editor.getText()).toBe('same same same')
  expect(() => api.replace(found, 'old')).toThrow(/stale/i)
})

it('refuses old references after editing, undo and document replacement', () => {
  const { api, editor, switchDocument } = fixture()
  const old = api.find('same')
  editor.commands.insertContent('x')
  expect(() => api.locate(old.matches[0])).toThrow(/stale/i)
  editor.commands.undo()
  expect(() => api.locate(old.matches[0])).toThrow(/stale/i)
  const next = api.find('same')
  switchDocument()
  expect(() => api.locate(next.matches[0])).toThrow(/stale/i)
  api.dispose()
  expect(() => api.find('same')).toThrow(/disposed/i)
})
