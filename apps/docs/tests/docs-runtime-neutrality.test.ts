import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { createDocsRuntime } from '../src/renderer/runtime/docs-runtime'

let editor: Editor | undefined
afterEach(() => {
  editor?.destroy()
  vi.unstubAllGlobals()
})

it('accepts an ordinary consumer identity and exposes editing primitives without model execution', async () => {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>Original</p>',
  })
  const active = editor
  const model = vi.fn(async () => ({ method: 'search', results: [] }))
  vi.stubGlobal('desktop', {
    webSearch: model,
    imageSearch: model,
    analyzeMedia: model,
    aiGenerateImage: model,
  })
  const runtime = createDocsRuntime({
    current: () => ({ editor: active, identity: active, numIds: { bullet: null, ordered: null } }),
  })
  try {
    const consumer = runtime.connect({ id: 'any-compatible-consumer' })
    consumer.context()
    const capabilities = JSON.parse(
      (await consumer.execute({ id: 'caps', name: 'get_editor_capabilities', input: {} })).output,
    )
    const modelTools = [
      'web_search',
      'image_search',
      'analyze_media',
      'generate_image',
      'write_document',
    ]
    expect(
      capabilities.tools.filter((tool: { name: string }) => modelTools.includes(tool.name)),
    ).toEqual([])
    expect(
      capabilities.tools.some((tool: { name: string }) => tool.name === 'start_document_draft'),
    ).toBe(true)
    const refused = await consumer.execute({
      id: 'inference',
      name: 'web_search',
      input: { query: 'test' },
    })
    expect(refused).toMatchObject({ isError: true, errorCode: 'unavailable', committed: false })
    expect(model).not.toHaveBeenCalled()
    const edited = await consumer.execute({
      id: 'edit',
      name: 'insert_content',
      input: { html: '<p>Shared edit</p>' },
    })
    expect(edited.isError, edited.output).not.toBe(true)
    expect(active.getText()).toContain('Shared edit')
  } finally {
    runtime.dispose()
  }
})
