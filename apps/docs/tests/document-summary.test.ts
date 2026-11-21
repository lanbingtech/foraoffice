import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { createDocumentSummary } from '../src/renderer/document-summary'
import { editorExtensions } from '../src/renderer/editor/extensions'
import * as revisions from '../src/renderer/editor/revisions'
import { PHASED_APPEND } from '../src/renderer/editor/streaming-tail-guard'
import { countWords, documentTextForWordCount } from '../src/renderer/word-count'

let editor: Editor | undefined
afterEach(() => {
  editor?.destroy()
  vi.restoreAllMocks()
})

it('reads only complete appended blocks while keeping full document counts and revision positions', () => {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>Prefix-</p>',
  })
  let state = editor.state
  const summary = createDocumentSummary(true)
  expect(summary.read(state.doc).words).toBe(1)
  const scan = vi.spyOn(revisions, 'collectRevisions')

  const type = state.schema.nodes.docParagraph
  const ins = state.schema.marks.ins.create({ author: 'Reviewer' })
  const blocks = [
    type.create(null, state.schema.text('suffix 中文。', [ins])),
    type.create(null, state.schema.text('Second paragraph')),
  ]
  for (const block of blocks) {
    const tr = state.tr.insert(state.doc.content.size, block).setMeta(PHASED_APPEND, true)
    summary.observe(tr, tr.doc)
    state = state.apply(tr)
  }

  const appended = summary.read(state.doc)
  expect(scan).toHaveBeenCalledTimes(1)
  expect(scan.mock.calls[0][0].childCount).toBe(2)
  expect(appended.words).toBe(countWords(documentTextForWordCount(state.doc)))
  expect(appended.revisions).toEqual(revisions.collectRevisions(state.doc))

  scan.mockClear()
  const edit = state.tr.insertText('editor ', 1)
  summary.observe(edit, edit.doc)
  state = state.apply(edit)
  const edited = summary.read(state.doc)
  expect(scan).toHaveBeenCalledExactlyOnceWith(state.doc)
  expect(edited.words).toBe(countWords(documentTextForWordCount(state.doc)))
  expect(edited.revisions).toEqual(revisions.collectRevisions(state.doc))
})
