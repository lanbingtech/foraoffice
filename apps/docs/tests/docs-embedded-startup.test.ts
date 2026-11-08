import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/editor-styles', () => ({}))
import { mountDocsEditor } from '../src/renderer/embedded'
import {
  createExternalDocsHost,
  installDocsHost,
  type DocsEditorServices,
} from '../src/renderer/host/docs-host'

it('rejects an aborted startup promptly, releases its host, and never rejects an unexposed ready handle', async () => {
  let release!: (lang: 'en') => void
  const language = new Promise<'en'>((resolve) => {
    release = resolve
  })
  const host = createExternalDocsHost('browser', {
    getLanguage: () => language,
    getTheme: async () => 'light',
    getDocumentTheme: async () => 'follow',
  } as DocsEditorServices)
  const controller = new AbortController()
  const pending = mountDocsEditor(document.createElement('div'), {
    host,
    signal: controller.signal,
  })
  const rejected = expect(pending).rejects.toThrow(/disposed/)
  controller.abort()
  await rejected
  const uninstall = installDocsHost(host)
  uninstall()
  release('en')
  await new Promise((resolve) => setTimeout(resolve, 0))
})
