import './editor-styles'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import type { Editor } from '@tiptap/core'
import { Step } from '@tiptap/pm/transform'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import type { OpenFileResult } from '../shared/ipc'
import type { ViewportBounds } from './editor/viewport-fragments'
import type { ViewportLayout } from './editor/viewport-layout'
import { createExternalDocsHost, installDocsHost, type DocsEditorServices } from './host/docs-host'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { waitForFullContent } from './phased-content'
import { TRACK_IGNORE } from './editor/revisions'

type LayoutMessage =
  | {
      type: 'open'
      file: OpenFileResult & { data: ArrayBuffer }
      language: Lang
      width: number
      height: number
    }
  | { type: 'viewport'; sequence: number; publication: number; bounds: ViewportBounds }
  | { type: 'edit'; fromRevision: number; toRevision: number; steps: unknown[] }

const noopSubscription = () => () => {}

function runLayout(
  port: MessagePort,
  { file, language, width, height }: Extract<LayoutMessage, { type: 'open' }>,
) {
  const { docsLayoutResources } = window as unknown as {
    docsLayoutResources: Pick<DocsEditorServices, 'fontMetrics' | 'getSystemLocale'>
  }
  // This renderer has no path, write, or native command authority. It opens
  // the bytes the document owner transferred through its dedicated port.
  const services = {
    consumePendingOpenDocx: async () => file,
    consumeNewBlankDoc: async () => false,
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    getRecentFiles: async () => [],
    getLanguage: async () => language,
    getTheme: async () => 'system',
    fontMetrics: docsLayoutResources.fontMetrics,
    getSystemLocale: docsLayoutResources.getSystemLocale,
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
    onLanguageChanged: noopSubscription,
    onMenuCommand: noopSubscription,
    onOpenDocx: noopSubscription,
    onRenamedDocx: noopSubscription,
    onZoteroRequest: noopSubscription,
  } satisfies Partial<DocsEditorServices>
  const uninstall = installDocsHost(
    createExternalDocsHost('browser', services as unknown as DocsEditorServices),
  )
  setModuleLang(language)
  document.documentElement.lang = htmlLang(language)
  document.documentElement.dir = htmlDir(language)
  const container = document.getElementById('root')!
  container.style.width = `${width}px`
  container.style.height = `${height}px`
  const root = createRoot(container, {
    onUncaughtError: (reason) => fail(String(reason)),
  })
  let layout: ViewportLayout | null = null
  let publication = 0
  let opened = false
  let editor: Editor | null = null
  let failed = false
  let receivedRevision = 0
  let revision = 0
  const edits: Array<Extract<LayoutMessage, { type: 'edit' }>> = []
  const fail = (reason: string) => {
    if (failed) return
    failed = true
    layout = null
    edits.length = 0
    port.postMessage({ type: 'failure', reason })
  }
  const applyEdits = () => {
    if (!editor || failed || edits.length === 0) return
    const transaction = editor.state.tr.setMeta('addToHistory', false).setMeta(TRACK_IGNORE, true)
    try {
      for (const edit of edits) {
        for (const raw of edit.steps) transaction.step(Step.fromJSON(editor.schema, raw))
      }
      revision = receivedRevision
      edits.length = 0
      if (editor.state.doc.eq(transaction.doc)) {
        if (layout) publish(layout)
        port.postMessage({ type: 'applied', revision })
        return
      }
      editor.view.dispatch(transaction)
      if (!editor.state.doc.eq(transaction.doc))
        throw new Error('The layout model refused the edit')
      port.postMessage({ type: 'applied', revision })
    } catch (reason) {
      fail(String(reason))
    }
  }
  port.onmessage = ({ data }: MessageEvent<LayoutMessage>) => {
    if (failed) return
    if (data?.type === 'edit') {
      if (
        data.fromRevision !== receivedRevision ||
        data.toRevision !== receivedRevision + 1 ||
        !Array.isArray(data.steps) ||
        data.steps.length === 0
      ) {
        fail('Layout edit revision does not match the document')
        return
      }
      receivedRevision = data.toRevision
      edits.push(data)
      applyEdits()
      return
    }
    if (
      data?.type !== 'viewport' ||
      !Number.isFinite(data.bounds?.top) ||
      !Number.isFinite(data.bounds?.bottom) ||
      data.bounds.bottom <= data.bounds.top
    )
      return
    const content = opened && data.publication === publication && layout?.read(data.bounds)
    port.postMessage({
      type: 'viewport',
      sequence: data.sequence,
      revision,
      publication,
      content: content || null,
    })
  }
  const publish = (next: ViewportLayout | null) => {
    const previous = layout
    layout = next
    publication++
    if (!opened || failed) return
    if (!next) {
      if (previous) port.postMessage({ type: 'invalidated', publication })
      return
    }
    port.postMessage({
      type: 'layout',
      publication,
      revision,
      pages: next.pages,
      starts: next.pageStarts(),
      initial: next.read({ top: 0, bottom: height }),
    })
  }
  const reportOpen = (openedEditor: Editor | null) => {
    if (!openedEditor) {
      fail('The document could not be opened for layout')
      return
    }
    void waitForFullContent().then((complete) => {
      if (!complete || openedEditor.isDestroyed) {
        fail('The document could not be completely opened for layout')
        return
      }
      editor = openedEditor
      if (edits.length === 0) {
        opened = true
        if (layout) publish(layout)
      } else {
        const previous = editor.state.doc
        applyEdits()
        opened = !failed
        if (opened && previous === editor.state.doc && layout) publish(layout)
      }
    })
  }
  root.render(
    <LocaleProvider initial={language}>
      <App onViewportLayout={publish} onViewportOpen={reportOpen} />
    </LocaleProvider>,
  )
  return () => {
    try {
      root.unmount()
    } finally {
      uninstall()
    }
  }
}

function acceptPort(event: MessageEvent) {
  if (event.source !== window || event.data !== 'docs:layout-port' || event.ports.length !== 1)
    return
  window.removeEventListener('message', acceptPort)
  const [port] = event.ports
  let cleanup: (() => void) | undefined
  const close = () => {
    try {
      cleanup?.()
    } finally {
      window.postMessage('docs:layout-disposed', '*')
    }
  }
  port.addEventListener('close', close, { once: true })
  port.onmessage = ({ data }: MessageEvent<LayoutMessage>) => {
    if (
      data?.type === 'open' &&
      data.file?.data instanceof ArrayBuffer &&
      Number.isInteger(data.width) &&
      data.width > 0 &&
      Number.isInteger(data.height) &&
      data.height > 0
    ) {
      try {
        cleanup = runLayout(port, data)
      } catch (reason) {
        port.postMessage({ type: 'failure', reason: String(reason) })
        port.close()
        close()
      }
    }
  }
}

window.addEventListener('message', acceptPort)
