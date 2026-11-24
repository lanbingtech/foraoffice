import { contextBridge, ipcRenderer } from 'electron'
import type { DocsEditorApi } from '../shared/ipc'

const resources: Pick<DocsEditorApi, 'fontMetrics' | 'getSystemLocale'> = {
  fontMetrics: (family) => ipcRenderer.invoke('docs:font-metrics', family),
  getSystemLocale: () => ipcRenderer.invoke('docs:system-locale'),
}
contextBridge.exposeInMainWorld('docsLayoutResources', resources)

ipcRenderer.once('docs:layout-port', ({ ports }) => {
  const [port] = ports
  if (port) window.postMessage('docs:layout-port', '*', [port])
})

window.addEventListener('message', (event) => {
  if (event.source === window && event.data === 'docs:layout-disposed')
    ipcRenderer.send('docs:layout-disposed')
})
