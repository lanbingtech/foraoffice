import {
  mountDocsEditor,
  createExternalDocsHost,
  type DocsEditorServices,
} from '@foraoffice/docs-sdk'
import '@foraoffice/docs-sdk/editor.css'

/** The embedding application supplies native/file services; there is no model configuration. */
export async function mountWord(container: HTMLElement, services: DocsEditorServices) {
  const editor = await mountDocsEditor(container, {
    host: createExternalDocsHost('browser', services),
  })
  try {
    await editor.ready
    return editor
  } catch (error) {
    editor.dispose()
    throw error
  }
}

export async function appendParagraph(editor: Awaited<ReturnType<typeof mountWord>>, html: string) {
  const caller = editor.runtime.connect({ id: crypto.randomUUID() })
  try {
    caller.context()
    const result = await caller.execute({
      id: crypto.randomUUID(),
      name: 'insert_content',
      input: { html },
    })
    if (result.isError) throw new Error(result.output)
    return result
  } finally {
    caller.close()
  }
}
