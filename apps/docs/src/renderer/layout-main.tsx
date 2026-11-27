import './editor-styles'
import { htmlDir, htmlLang } from '@genoffice/i18n'
import type { Editor } from '@tiptap/core'
import { ReplaceStep, Step } from '@tiptap/pm/transform'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LAYOUT_REPLAY } from './editor/authored-document'
import type { PmNode } from './editor/convert'
import type { LayoutMessage, LayoutReply, ViewportLayoutDetails } from './editor/layout-client'
import { viewportContent, type ViewportLayout } from './editor/viewport-layout'
import { createExternalDocsHost, installDocsHost, type DocsEditorServices } from './host/docs-host'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { isPhasedContentPending, waitForFullContent } from './phased-content'
import { TRACK_IGNORE } from './editor/revisions'

const noopSubscription = () => () => {}
const SOURCE_BLOCKS_PER_CHUNK = 50
const OPENING_VIEWPORT_BUDGET_MS = 2_000
const OPENING_CHECKPOINT_TIMEOUT_MS = 4_000

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
  let openingThrough = 0
  let openingSourceEnd = 0
  let openingRevision = -1
  let openingPublication = 0
  let openingSnapshot: Extract<LayoutReply, { type: 'layout' }> | undefined
  let openingDemand = 0
  let waitingBatch: (() => void) | undefined
  let waitForMeasurement: number | undefined
  let checkpointThru = 0
  const runNextBatch = () => {
    if (waitForMeasurement !== undefined) window.clearTimeout(waitForMeasurement)
    waitForMeasurement = undefined
    const next = waitingBatch
    waitingBatch = undefined
    if (next) window.setTimeout(next, 0)
  }
  const aimAtOpeningDemand = () => {
    const pane = container.querySelector<HTMLElement>('.editor-scroll')
    if (pane && pane.scrollTop < openingDemand - height) pane.scrollTop = openingDemand - height
    return pane
  }
  const scheduleTail = (next: () => void) => {
    const pane = openingDemand > Math.max(checkpointThru, openingThrough) && aimAtOpeningDemand()
    if (!pane || pane.scrollHeight < openingDemand) {
      window.setTimeout(next, 0)
      return
    }
    checkpointThru = openingDemand
    waitingBatch = next
    waitForMeasurement = window.setTimeout(runNextBatch, OPENING_CHECKPOINT_TIMEOUT_MS)
  }
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
      // Give the small initial layout a turn before mounting the tail.
      // Some documents cannot publish an exact prefix, so always release it.
      tailTimer = window.setTimeout(() => releaseTail(true), OPENING_VIEWPORT_BUDGET_MS)
    }
  }
  const fail = (reason: string) => {
    if (failed) return
    failed = true
    layout = null
    waitingBatch = undefined
    runNextBatch()
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
      const steps = edits.flatMap((edit) =>
        edit.steps.map((raw) => Step.fromJSON(editor!.schema, raw)),
      )
      // The mounted prefix can safely accept ordinary text replacements before
      // the appended tail. Other commands keep their place in the full replay.
      const partial = isPhasedContentPending()
      let safeEnd = openingSourceEnd
      for (const step of steps) {
        if (partial && (!(step instanceof ReplaceStep) || step.to >= safeEnd)) return
        transaction.step(step)
        if (partial) safeEnd = step.getMap().map(safeEnd, -1)
      }
      if (partial) {
        openingSourceEnd = safeEnd
        openingDemand = Math.max(openingDemand, openingThrough + height)
        checkpointThru = 0
        aimAtOpeningDemand()
      }
      const beforeRevision = revision
      revision = receivedRevision
      edits.length = 0
      if (editor.state.doc.eq(transaction.doc)) {
        if (partial && openingSnapshot?.revision === beforeRevision) {
          openingRevision = revision
          openingPublication = ++publication
          openingSnapshot = { ...openingSnapshot, publication: openingPublication, revision }
          port.postMessage(openingSnapshot)
        } else if (layout) publish(layout, details)
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
    if (data?.type === 'opening-demand') {
      if (!opened && data.publication === openingPublication && Number.isFinite(data.bottom)) {
        openingDemand = Math.max(openingDemand, data.bottom)
        aimAtOpeningDemand()
      }
      return
    }
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
    const frames = layout.pageFrames()
    openingSnapshot = undefined
    port.postMessage({
      type: 'layout',
      publication,
      revision,
      pages: layout.pages,
      starts: layout.pageStarts(),
      pageFrames: frames,
      ...details,
      geometry: layout.geometry(),
      initial: layout.read({ top: 0, bottom: height }),
    } satisfies LayoutReply)
  }
  const publishInitialViewport = (next: ViewportLayout, modelEnd: number, paperEnd: number) => {
    if (opened || failed || receivedRevision !== revision || paperEnd < height) return
    if (paperEnd + 1 < openingThrough) return
    const frames = next.pageFrames()
    const trailingPosition = next.pageStarts()?.at(-1)
    const measured = frames && trailingPosition != null && next.geometry()
    if (!measured || !frames || trailingPosition == null) return
    const stableEnd = Math.min(modelEnd, trailingPosition)
    const limit = measured.blocks.reduce(
      (end, { ink, placement }) =>
        placement.to > stableEnd ? Math.min(end, (ink ?? placement.box).top) : end,
      paperEnd,
    )
    const keptFrames = frames.filter((frame) => frame.top + frame.height <= limit + 1)
    const last = keptFrames.at(-1)
    if (!last) return
    const through = last.top + last.height
    if (through < height || through < openingThrough) return
    if (openingRevision === revision && through === openingThrough) return
    const blocks = measured.blocks.filter(
      ({ ink, placement }) => (ink ?? placement.box).top < through,
    )
    if (blocks.some(({ placement }) => placement.to > stableEnd)) return
    const geometry = {
      ...measured,
      canvas: { ...measured.canvas, height: through },
      blocks,
    }
    const initial = viewportContent(geometry, { top: 0, bottom: height }, next.document)
    if (!initial.model) return
    openingThrough = through
    openingRevision = revision
    openingSourceEnd = stableEnd
    openingPublication = ++publication
    runNextBatch()
    initialViewportPublished = true
    openingSnapshot = {
      type: 'layout',
      publication: openingPublication,
      revision,
      opening: true,
      pages: next.pages.slice(0, last.cutIndex + 1),
      starts: keptFrames.map((frame) => frame.sourceStart),
      pageFrames: keptFrames,
      geometry,
      initial,
    }
    port.postMessage(openingSnapshot)
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
    editor = openedEditor
    applyEdits()
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
        sourceImport={
          includeSource ? { publish: publishSource, canMountTail, scheduleTail } : undefined
        }
      />
    </LocaleProvider>,
  )
  return () => {
    waitingBatch = undefined
    runNextBatch()
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
