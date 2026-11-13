import { mountDocsEditor, createQtDocsHost } from '/sdk/editor.js'

try {
  const channel = await window.docsQtChannel
  const host = createQtDocsHost(channel)
  await host.refreshResources()
  const editor = await mountDocsEditor(document.getElementById('root'), { host: host.host })
  await editor.ready
  const dispose = () => {
    editor.dispose()
    host.dispose()
  }
  window.docsEditor = {
    ready: editor.ready,
    get runtime() {
      return editor.runtime
    },
    get commands() {
      return editor.commands
    },
    get inspection() {
      return editor.inspection
    },
    get annotations() {
      return editor.annotations
    },
    get documents() {
      return editor.documents
    },
    get ui() {
      return editor.ui
    },
    dispose,
  }
  host.attach(editor)
  window.addEventListener('pagehide', dispose, { once: true })
} catch (error) {
  document.getElementById('root').textContent =
    error instanceof Error ? error.message : String(error)
}
