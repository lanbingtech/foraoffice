import './editor-styles'
import { htmlDir, htmlLang } from '@genoffice/i18n'
import type { Editor } from '@tiptap/core'
import { Step } from '@tiptap/pm/transform'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LAYOUT_REPLAY } from './editor/authored-document'
import type { PmNode } from './editor/convert'
import type { LayoutMessage, LayoutReply, ViewportLayoutDetails } from './editor/layout-client'
import type { ViewportLayout } from './editor/viewport-layout'
import { createExternalDocsHost, installDocsHost, type DocsEditorServices } from './host/docs-host'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { waitForFullContent } from './phased-content'
import { TRACK_IGNORE } from './editor/revisions'

const noopSubscription = () => () => {}
const SOURCE_BLOCKS_PER_CHUNK = 50
const OPENING_VIEWPORT_BUDGET_MS = 2_000

function runLayout(
  port: MessagePort,
  { file, language, width, height, includeSource }: Extract<LayoutMessage, { type: 'open' }>,
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
  let details: ViewportLayoutDetails | undefined
  let initialViewportPublished = false
  let publication = 0
  let opened = false
  let editor: Editor | null = null
  let failed = false
  let receivedRevision = 0
  let revision = 0
  let stopSource: ((reason: Error) => void) | undefined
  let tailTimer: number | undefined
  let releaseTail!: (mount: boolean) => void
  const canMountTail = new Promise<boolean>((resolve) => (releaseTail = resolve))
  const edits: Array<Extract<LayoutMessage, { type: 'edit' }>> = []
  const finishSource = (mount: boolean) => {
    stopSource = undefined
    if (!mount || initialViewportPublished) {
      window.clearTimeout(tailTimer)
      releaseTail(mount)
    } else {
      // Give the small initial layout a turn before mounting the full tail.
      // Some documents cannot publish an exact prefix, so always release it.
      tailTimer = window.setTimeout(() => releaseTail(true), OPENING_VIEWPORT_BUDGET_MS)
    }
  }
  const fail = (reason: string) => {
    if (failed) return
    failed = true
    layout = null
    edits.length = 0
    stopSource?.(new Error(reason))
    finishSource(false)
    port.postMessage({ type: 'failure', reason })
  }
  const publishSource = ({ content = [], ...sourceRoot }: PmNode) => {
    if (failed) return
    let offset = 0
    const blocks = new ReadableStream<PmNode[]>({
      start(controller) {
        stopSource = (reason) => controller.error(reason)
      },
      pull(controller) {
        if (offset < content.length) {
          const nextOffset = offset + SOURCE_BLOCKS_PER_CHUNK
          controller.enqueue(content.slice(offset, nextOffset))
          offset = nextOffset
        }
        if (offset >= content.length) {
          controller.close()
          finishSource(true)
        }
      },
      // A plain discard still wants geometry. An aborted read retires the open.
      cancel: (reason) => finishSource(reason === undefined),
    })
    port.postMessage(
      { type: 'source', revision: 0, root: sourceRoot, blocks } satisfies LayoutReply,
      [blocks],
    )
  }
  const applyEdits = () => {
    if (!editor || failed || edits.length === 0) return
    const transaction = editor.state.tr
      .setMeta(LAYOUT_REPLAY, true)
      .setMeta('addToHistory', false)
      .setMeta(TRACK_IGNORE, true)
    try {
      for (const edit of edits) {
        for (const raw of edit.steps) transaction.step(Step.fromJSON(editor.schema, raw))
      }
      revision = receivedRevision
      edits.length = 0
      if (editor.state.doc.eq(transaction.doc)) {
        if (layout) publish(layout, details)
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
    if (data?.type === 'reveal') {
      const result =
        opened && data.revision === revision && data.publication === publication
          ? layout?.reveal(data.position, data.height, data.scope)
          : undefined
      const stamp = {
        sequence: data.sequence,
        revision: data.revision,
        publication: data.publication,
      }
      port.postMessage(
        result
          ? { type: 'viewport', ...stamp, ...result }
          : { type: 'reveal-unavailable', ...stamp, position: data.position },
      )
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
  const publish = (next: ViewportLayout | null, measuredDetails?: ViewportLayoutDetails) => {
    const previous = layout
    layout = editor && next?.document !== editor.state.doc ? null : next
    details = layout ? measuredDetails : undefined
    publication++
    if (!opened || failed) return
    if (!layout) {
      if (previous) port.postMessage({ type: 'invalidated', publication })
      return
    }
    port.postMessage({
      type: 'layout',
      publication,
      revision,
      pages: layout.pages,
      starts: layout.pageStarts(),
      pageFrames: layout.pageFrames(),
      ...details,
      geometry: layout.geometry(),
      initial: layout.read({ top: 0, bottom: height }),
    } satisfies LayoutReply)
  }
  const publishInitialViewport = (next: ViewportLayout, modelEnd: number, paperEnd: number) => {
    if (initialViewportPublished || opened || failed || receivedRevision !== 0) return
    // Loading can still extend the last measured page. Keep its geometry and
    // its source positions outside the opening range.
    if (paperEnd < height) return
    const content = next.read({ top: 0, bottom: height })
    const trailingPosition = next.pageStarts()?.at(-1)
    if (
      !content?.model ||
      trailingPosition == null ||
      content.model.to > Math.min(modelEnd, trailingPosition)
    )
      return
    initialViewportPublished = true
    port.postMessage({ type: 'initial-viewport', revision: 0, content } satisfies LayoutReply)
    if (tailTimer !== undefined) {
      window.clearTimeout(tailTimer)
      releaseTail(true)
    }
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
        if (layout) publish(layout, details)
      } else {
        const previous = editor.state.doc
        applyEdits()
        opened = !failed
        if (opened && previous === editor.state.doc && layout) publish(layout, details)
      }
    })
  }
  root.render(
    <LocaleProvider initial={language}>
      <App
        onViewportLayout={publish}
        onInitialViewport={includeSource ? publishInitialViewport : undefined}
        onViewportOpen={reportOpen}
        sourceImport={includeSource ? { publish: publishSource, canMountTail } : undefined}
      />
    </LocaleProvider>,
  )
  return () => {
    stopSource?.(new Error('The background layout connection closed'))
    finishSource(false)
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
