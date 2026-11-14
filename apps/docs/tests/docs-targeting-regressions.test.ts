import { afterEach, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { executeOps } from '../src/renderer/ai/ops'
import { serializeRangeToHtml } from '../src/renderer/ai/protocol'
import { createDocsRuntime } from '../src/renderer/runtime/docs-runtime'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})
function create(content: object[]) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  editors.push(editor)
  return editor
}
const paragraph = (text: string) => ({ type: 'docParagraph', content: [{ type: 'text', text }] })
const cell = (text: string, attrs = {}) => ({
  type: 'docTableCell',
  attrs: { colspan: 1, rowspan: 1, ...attrs },
  content: [paragraph(text)],
})
const table = () => ({
  type: 'docTable',
  content: [
    { type: 'docTableRow', content: [cell('merged', { colspan: 2, rowspan: 2 }), cell('top')] },
    { type: 'docTableRow', content: [cell('bottom')] },
  ],
})

it.each([false, true])(
  'rejects a table list target with a domain error and rolls back the whole batch (dryRun=%s)',
  (dryRun) => {
    const editor = create([paragraph('Keep me'), table()])
    const before = editor.getJSON()
    const result = executeOps(
      editor,
      [
        { op: 'setList', target: { blockIndexes: [0] } },
        { op: 'setList', target: { blockIndexes: [1] } },
      ],
      { dryRun },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/setList.*docTable/)
    expect(result.error).not.toContain('Invalid content for node')
    expect(editor.getJSON()).toEqual(before)
  },
)

it('describes merged cells with spans and grid coordinates without synthetic cells', () => {
  const editor = create([table()])
  const dom = new DOMParser().parseFromString(serializeRangeToHtml(editor, 0, 0), 'text/html')
  const cells = [...dom.querySelectorAll('td,th')]
  expect(cells).toHaveLength(3)
  expect(cells[0].getAttribute('colspan')).toBe('2')
  expect(cells[0].getAttribute('rowspan')).toBe('2')
  expect(cells[2].getAttribute('data-row')).toBe('1')
  expect(cells[2].getAttribute('data-col')).toBe('2')
})

it('reads each inline image using the same image ordinal exposed in read_blocks', async () => {
  const urls = ['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']
  const editor = create([
    {
      type: 'docParagraph',
      content: urls.map((dataUrl) => ({ type: 'docInlineImage', attrs: { dataUrl } })),
    },
  ])
  const runtime = createDocsRuntime({
    current: () => ({ editor, identity: editor, numIds: { bullet: null, ordered: null } }),
  })
  try {
    const caller = runtime.connect({ id: 'inline-media' })
    caller.context()
    for (let imageIndex = 0; imageIndex < 2; imageIndex++) {
      const result = await caller.execute({
        id: `image-${imageIndex}`,
        name: 'read_document_media',
        input: { blockIndex: 0, imageIndex },
      })
      expect(result.isError, result.output).not.toBe(true)
      expect(result.media?.data).toBe(imageIndex === 0 ? 'AQ==' : 'Ag==')
    }
  } finally {
    runtime.dispose()
  }
})

it('preserves merged table geometry through the restricted-HTML write path', async () => {
  const { parseHtmlFragment } = await import('../src/renderer/ai/protocol')
  const editor = create([table()])
  const html = serializeRangeToHtml(editor, 0, 0)
  const nodes = parseHtmlFragment(html, { bullet: null, ordered: null })
  editor.commands.setContent({ type: 'doc', content: nodes })
  const dom = new DOMParser().parseFromString(serializeRangeToHtml(editor, 0, 0), 'text/html')
  const merged = dom.querySelector('[colspan="2"][rowspan="2"]')
  expect(merged?.textContent).toBe('merged')
  expect(dom.querySelectorAll('td,th')).toHaveLength(3)
})

it('expires media references across edits even after the caller refreshes its context', async () => {
  const editor = create([
    {
      type: 'docParagraph',
      content: [{ type: 'docInlineImage', attrs: { dataUrl: 'data:image/png;base64,AQ==' } }],
    },
  ])
  const runtime = createDocsRuntime({
    current: () => ({ editor, identity: editor, numIds: { bullet: null, ordered: null } }),
  })
  try {
    const caller = runtime.connect({ id: 'media-revision' })
    const old = /media:[a-z0-9-]+:\d+:0\.0/.exec(caller.context().text)![0]
    editor.commands.insertContent('new text')
    caller.context()
    expect(
      await caller.execute({
        id: 'expired',
        name: 'read_document_media',
        input: { mediaRef: old },
      }),
    ).toMatchObject({ isError: true, errorCode: 'stale_target', committed: false })
    const fresh = /media:[a-z0-9-]+:\d+:0\.0/.exec(caller.context().text)![0]
    expect(
      await caller.execute({
        id: 'fresh',
        name: 'read_document_media',
        input: { mediaRef: fresh },
      }),
    ).toMatchObject({ media: { data: 'AQ==' }, committed: false })
    const revision = caller.context().revision
    expect(
      await caller.execute({
        id: 'preview',
        name: 'apply_ops',
        input: { dryRun: true, ops: [{ op: 'setList', target: { blockIndexes: [0] } }] },
      }),
    ).toMatchObject({ committed: false, revision })
  } finally {
    runtime.dispose()
  }
})

it('distinguishes unsupported targets from missing image bytes', async () => {
  const editor = create([
    paragraph('text'),
    { type: 'docParagraph', content: [{ type: 'docInlineImage', attrs: { dataUrl: '' } }] },
  ])
  const runtime = createDocsRuntime({
    current: () => ({ editor, identity: editor, numIds: { bullet: null, ordered: null } }),
  })
  try {
    const caller = runtime.connect({ id: 'missing-media' })
    caller.context()
    expect(
      await caller.execute({
        id: 'unsupported',
        name: 'read_document_media',
        input: { blockIndex: 0 },
      }),
    ).toMatchObject({ errorCode: 'invalid_input', isError: true })
    expect(
      await caller.execute({
        id: 'missing',
        name: 'read_document_media',
        input: { blockIndex: 1 },
      }),
    ).toMatchObject({ errorCode: 'unavailable', isError: true })
  } finally {
    runtime.dispose()
  }
})

it('keeps vertical merges through the actual replace_blocks formatting inheritance path', async () => {
  const editor = create([table()])
  const runtime = createDocsRuntime({
    current: () => ({
      editor,
      identity: editor,
      numIds: { bullet: null, ordered: null },
      autoAcceptUntracked: true,
    }),
  })
  try {
    const caller = runtime.connect({ id: 'merged-rewrite' })
    caller.context()
    const read = await caller.execute({
      id: 'read',
      name: 'read_blocks',
      input: { startBlockIndex: 0, endBlockIndex: 0 },
    })
    expect(
      await caller.execute({
        id: 'rewrite',
        name: 'replace_blocks',
        input: {
          startBlockIndex: 0,
          endBlockIndex: 0,
          html: read.output.replace('merged', 'rewritten'),
        },
      }),
    ).toMatchObject({ committed: true })
    const after = await caller.execute({
      id: 'verify',
      name: 'read_blocks',
      input: { startBlockIndex: 0, endBlockIndex: 0 },
    })
    const dom = new DOMParser().parseFromString(after.output, 'text/html')
    expect(dom.querySelector('[colspan="2"][rowspan="2"]')?.textContent).toBe('rewritten')
    expect(dom.querySelectorAll('td,th')).toHaveLength(3)
    expect(dom.querySelector('[data-row="1"][data-col="2"]')?.textContent).toBe('bottom')
  } finally {
    runtime.dispose()
  }
})
