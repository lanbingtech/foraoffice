import type { Editor, EditorEvents, Extensions } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { AuthoredEditor, type AuthoredDocument } from './authored-document'
import {
  connectDesktopLayout,
  type LayoutClient,
  type LayoutMessage,
  type LayoutReply,
} from './layout-client'
import type { ViewportBounds } from './viewport-fragments'
import type { ViewportReveal } from './viewport-layout'
import {
  createViewportSurface,
  type ViewportPacket,
  type ViewportRangeRequest,
  type ViewportSurface,
  type ViewportSurfaceOptions,
} from './viewport-surface'

type LayoutOpen = Extract<LayoutMessage, { type: 'open' }>
type LayoutPublication = Extract<LayoutReply, { type: 'layout' }>
type InitialViewport = Extract<LayoutReply, { type: 'initial-viewport' }>
type NavigationTarget = NonNullable<ViewportRangeRequest['target']>
const FIRST_FRAME_TIMEOUT_MS = 30_000

export interface DocumentViewportSessionOptions {
  mount: HTMLElement
  scroller: HTMLElement
  extensions: Extensions
  configure?(editor: Editor): void
  onReady(editor: Editor): void
  onLayout?(layout: LayoutPublication | null): void
  onPage?(page: number, total: number): void
  /** Take ownership synchronously to retain the live editor after failure. */
  onFailure(reason: string, takeEditor: () => Editor | undefined): void
  surface?: Pick<
    ViewportSurfaceOptions,
    'attributes' | 'clipboard' | 'editable' | 'nodeViews' | 'decorations'
  >
}

interface Navigation {
  target?: NavigationTarget
  headAtStart?: boolean
}

/** The window is measured by the layout renderer. The foreground editor owns
 * the full accepted model and only constructs DOM for a verified window. */
export function startDocumentViewportSession(
  open: LayoutOpen,
  options: DocumentViewportSessionOptions,
) {
  const { mount, scroller } = options
  const window = mount.ownerDocument.defaultView!
  let client: LayoutClient | undefined
  let editor: AuthoredEditor | undefined
  let authored: AuthoredDocument | undefined
  let surface: ViewportSurface | undefined
  let layout: LayoutPublication | undefined
  let initial: InitialViewport | undefined
  let navigation: Navigation | undefined
  let latestPacket: ViewportPacket | undefined
  let displayedPublication: number | undefined
  let acceptedReveal:
    { packet: ViewportPacket; navigation: Navigation; reveal: ViewportReveal } | undefined
  let lastPage: { page: number; total: number } | undefined
  let readyTimer: number | undefined
  let ready = false
  let stopped = false
  let failing = false
  let dispatching = false
  let publishing = false
  let refreshQueued = false

  const canvasScale = () => mount.currentCSSZoom || 1
  const scrollerScale = () => scroller.currentCSSZoom || 1
  const canvasOffset = () =>
    scroller.getBoundingClientRect().top +
    scroller.clientTop * scrollerScale() -
    mount.getBoundingClientRect().top
  const readBounds = (): ViewportBounds => {
    if (!mount.isConnected) return { top: 0, bottom: open.height }
    const scale = canvasScale()
    const top = Math.max(0, canvasOffset() / scale)
    const height = (scroller.clientHeight * scrollerScale()) / scale || open.height
    return { top, bottom: top + height }
  }
  let bounds = readBounds()

  const publishPage = (packet: ViewportPacket) => {
    if (!options.onPage || layout?.publication !== packet.publication) return
    const frames = layout.pageFrames
    if (!frames?.length) return
    const midpoint = (bounds.top + bounds.bottom) / 2
    let low = 0
    let high = frames.length - 1
    while (low < high) {
      const middle = (low + high) >>> 1
      const previous = frames[middle]
      const between = (previous.top + previous.height + frames[middle + 1].top) / 2
      if (midpoint < between) high = middle
      else low = middle + 1
    }
    const page = low + 1
    const total = frames.length
    if (lastPage?.page === page && lastPage.total === total) return
    lastPage = { page, total }
    options.onPage(page, total)
  }

  const revealPosition = (intent: Navigation) => {
    const { target } = intent
    if (target) return target.align === 'node' || intent.headAtStart ? target.from : target.to
    const selection = authored!.read().state.selection
    return selection instanceof TextSelection ? selection.head : selection.from
  }

  const requestLatest = () => {
    const connection = client
    if (failing || !connection || !authored || layout?.revision !== authored.read().revision) return
    const { revision } = layout
    latestPacket = undefined
    acceptedReveal = undefined
    if (
      navigation &&
      connection.requestReveal(revealPosition(navigation), bounds.bottom - bounds.top, revision)
    )
      return
    connection.request(bounds)
  }

  const refreshBounds = (scrolled: boolean) => {
    const next = readBounds()
    if (bounds.top === next.top && bounds.bottom === next.bottom) return
    if (scrolled && bounds.top !== next.top) navigation = undefined
    bounds = next
    requestLatest()
  }
  const onScroll = () => refreshBounds(true)
  const onResize = () => refreshBounds(false)
  const resize =
    typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(onResize) : undefined

  const queueRefresh = () => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      if (!stopped) requestLatest()
    })
  }

  const onTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
    const chain = [transaction, ...appendedTransactions]
    if (navigation?.target) {
      const target = navigation.target
      for (const applied of chain) {
        const from = applied.mapping.map(target.from, 1)
        target.to =
          target.to === target.from ? from : Math.max(from, applied.mapping.map(target.to, -1))
        target.from = from
      }
    }
    if (dispatching || !ready || stopped) return
    if (!navigation?.target && chain.some((applied) => applied.scrolledIntoView)) navigation = {}
    if (
      chain.some(
        (applied) => applied.selectionSet || applied.storedMarksSet || applied.scrolledIntoView,
      )
    )
      queueRefresh()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    window.clearTimeout(readyTimer)
    scroller.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onResize)
    resize?.disconnect()
    editor?.off('transaction', onTransaction)
    surface?.destroy()
    surface = undefined
    client?.dispose()
    client = undefined
    initial = undefined
    layout = undefined
    navigation = undefined
    latestPacket = undefined
    acceptedReveal = undefined
  }

  const destroyOwner = () => {
    authored?.destroy()
    authored = undefined
    editor = undefined
  }

  const takeEditor = () => {
    if (!ready || !editor) return
    stop()
    const owner = editor
    owner.dispatchAuthored = undefined
    owner.acceptAuthored = undefined
    authored = undefined
    editor = undefined
    return owner
  }

  const fail = (reason: string) => {
    if (stopped || failing) return
    failing = true
    try {
      options.onFailure(reason, takeEditor)
    } finally {
      stop()
      destroyOwner()
    }
  }

  const publish = (packet: ViewportPacket, opening = false) => {
    if (failing || !surface) return
    latestPacket = packet
    let result: ReturnType<ViewportSurface['publish']>
    publishing = true
    try {
      result = surface.publish(packet)
    } catch (reason) {
      fail(String(reason))
      return
    } finally {
      publishing = false
    }
    if (result === 'needs-range' && !opening)
      fail('The measured viewport did not match the document')
  }

  const updateFrame = () => {
    if (!authored || stopped) return
    bounds = readBounds()
    if (layout) {
      if (!navigation && bounds.top === 0 && bounds.bottom === open.height && layout.initial) {
        publish({
          revision: layout.revision,
          publication: layout.publication,
          sequence: 0,
          content: layout.initial,
        })
      } else {
        requestLatest()
      }
    } else if (initial) {
      publish(
        { revision: initial.revision, publication: 0, sequence: 0, content: initial.content },
        true,
      )
    }
  }

  scroller.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)
  resize?.observe(scroller)
  resize?.observe(mount)
  try {
    client = connectDesktopLayout(open, {
      retainCommittedViewport: (publication) => displayedPublication === publication,
      source: {
        extensions: options.extensions,
        configure(owner) {
          options.configure?.(owner)
          if (owner instanceof AuthoredEditor) editor = owner
        },
        opened(document) {
          authored = document
          const owner = editor!
          owner.on('transaction', onTransaction)
          try {
            surface = createViewportSurface(mount, {
              ...options.surface,
              ownerEditor: owner,
              isCurrent: (packet) => latestPacket === packet,
              readSource: () => document.read(),
              dispatch(transaction) {
                dispatching = true
                try {
                  return document.dispatch(transaction)
                } finally {
                  dispatching = false
                }
              },
              requestRange(request) {
                if (stopped || publishing || request.revision !== document.read().revision) return
                if (request.target) {
                  const { selection, target } = request
                  navigation = {
                    target: { ...target },
                    headAtStart:
                      !(selection instanceof TextSelection) || selection.head === target.from,
                  }
                } else if (!navigation?.target) {
                  navigation = {}
                }
                requestLatest()
              },
              onPublished(packet) {
                displayedPublication = packet.publication
                if (acceptedReveal?.packet === packet) {
                  const accepted = acceptedReveal
                  acceptedReveal = undefined
                  if (navigation === accepted.navigation) {
                    navigation = undefined
                    scroller.scrollTop +=
                      (accepted.reveal.top * canvasScale() - canvasOffset()) / scrollerScale()
                    bounds = readBounds()
                  }
                }
                if (!ready) {
                  ready = true
                  window.clearTimeout(readyTimer)
                  options.onReady(owner)
                }
                publishPage(packet)
              },
            })
            updateFrame()
          } catch (reason) {
            fail(String(reason))
          }
        },
      },
      initialViewport(publication) {
        initial = publication ?? undefined
        if (initial) updateFrame()
        else if (!layout && authored) surface?.invalidate(0, authored.read().revision)
      },
      layout(publication, stamp) {
        if (stopped) return
        layout = publication ?? undefined
        if (!publication && authored) surface?.invalidate(stamp, authored.read().revision)
        options.onLayout?.(publication)
        if (publication) updateFrame()
      },
      viewport(reply) {
        const { reveal } = reply
        acceptedReveal =
          navigation &&
          reveal &&
          Number.isFinite(reveal.top) &&
          reveal.position === revealPosition(navigation)
            ? { packet: reply, navigation, reveal }
            : undefined
        if (reveal && !acceptedReveal) return
        publish(reply)
      },
      revealUnavailable(position) {
        if (navigation && position === revealPosition(navigation))
          fail('The document position could not be revealed in the measured viewport')
      },
      failure: fail,
    })
    if (!ready && !stopped) {
      readyTimer = window.setTimeout(
        () => fail('The background layout did not produce an opening viewport'),
        FIRST_FRAME_TIMEOUT_MS,
      )
    }
  } catch (reason) {
    fail(String(reason))
  }

  return {
    pagePositions() {
      if (layout?.revision !== authored?.read().revision) return
      return layout?.starts
    },
    dispose() {
      stop()
      destroyOwner()
    },
    takeEditor,
  }
}
