import type { Lang } from '@genoffice/i18n'
import type { Transaction } from '@tiptap/pm/state'
import type { OpenFileResult } from '../../shared/ipc'
import type { PageCut } from '../pagination-cuts'
import type { PmNode } from './convert'
import type { ViewportBounds } from './viewport-fragments'
import {
  viewportContent,
  type ViewportContent,
  type ViewportGeometry,
  type ViewportReveal,
} from './viewport-layout'

export type LayoutMessage =
  | {
      type: 'open'
      file: OpenFileResult & { data: ArrayBuffer }
      language: Lang
      width: number
      height: number
      includeSource?: boolean
    }
  | { type: 'viewport'; sequence: number; publication: number; bounds: ViewportBounds }
  | (ViewportRequestStamp & { type: 'reveal'; position: number; height: number })
  | { type: 'edit'; fromRevision: number; toRevision: number; steps: unknown[] }

type LayoutPublication = {
  type: 'layout'
  publication: number
  revision: number
  pages: readonly PageCut[]
  starts?: readonly (number | null)[]
  geometry?: ViewportGeometry
  initial?: ViewportContent
}

interface ViewportRequestStamp {
  publication: number
  revision: number
  sequence: number
}

type ViewportPublication = ViewportRequestStamp & {
  type: 'viewport'
  content: ViewportContent | null
  reveal?: ViewportReveal
}

type ImportedSource = {
  type: 'source'
  revision: 0
  root: Omit<PmNode, 'content'>
  blocks: ReadableStream<PmNode[]>
}

export type LayoutReply =
  | LayoutPublication
  | ImportedSource
  | { type: 'invalidated'; publication: number }
  | { type: 'applied'; revision: number }
  | ViewportPublication
  | (ViewportRequestStamp & { type: 'reveal-unavailable'; position: number })
  | { type: 'failure'; reason: string }

interface LayoutClientEvents {
  /** Consume the source or cancel it without an error to continue to layout.
   * Bind reads to the connection signal with `blocks.pipeTo(writable, { signal })`. */
  source?(source: ImportedSource, signal: AbortSignal): void
  layout(layout: LayoutPublication | null, publication: number): void
  viewport(reply: ViewportPublication & { content: ViewportContent }): void
  revealUnavailable(position: number): void
  failure(reason: string): void
}

export class LayoutClient {
  private revision = 0
  private sequence = 0
  private latestPublication = 0
  private active?: LayoutPublication
  private closed = false
  private readonly lifetime = new AbortController()

  constructor(
    private readonly port: MessagePort,
    private readonly events: LayoutClientEvents,
    private readonly resolution?: MediaQueryList,
  ) {
    port.addEventListener('message', this.receive)
    port.addEventListener('close', this.lost, { once: true })
    resolution?.addEventListener('change', this.displayChanged)
    port.start()
  }

  request(bounds: ViewportBounds): void {
    if (!this.displayIsCurrent() || !this.active) return
    const { geometry, publication, revision } = this.active
    const sequence = ++this.sequence
    if (geometry) {
      const content = viewportContent(geometry, bounds)
      this.events.viewport({
        type: 'viewport',
        publication,
        revision,
        sequence,
        content,
      })
      return
    }
    this.send({
      type: 'viewport',
      publication,
      sequence,
      bounds,
    })
  }

  /** Reveal a position from the same source revision as the current layout. */
  requestReveal(position: number, height: number, revision: number): boolean {
    if (
      !this.displayIsCurrent() ||
      !this.active ||
      revision !== this.revision ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isFinite(height) ||
      height <= 0
    )
      return false
    this.send({
      type: 'reveal',
      publication: this.active.publication,
      revision,
      sequence: ++this.sequence,
      position,
      height,
    })
    return true
  }

  apply(transactions: readonly Transaction[]): void {
    if (!this.displayIsCurrent()) return
    const steps = transactions.flatMap((transaction) =>
      transaction.steps.map((step) => step.toJSON()),
    )
    if (steps.length === 0) return
    const fromRevision = this.revision++
    this.send({ type: 'edit', fromRevision, toRevision: this.revision, steps })
    this.clear()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    this.port.removeEventListener('message', this.receive)
    this.port.removeEventListener('close', this.lost)
    this.resolution?.removeEventListener('change', this.displayChanged)
    this.port.close()
    this.clear()
  }

  private send(message: LayoutMessage): void {
    this.port.postMessage(message)
  }

  private clear(): void {
    if (!this.active) return
    this.active = undefined
    this.events.layout(null, this.latestPublication)
  }

  private lost = (): void => {
    if (this.closed) return
    this.dispose()
    this.events.failure('The background layout connection closed')
  }

  private displayChanged = (): void => {
    if (this.closed) return
    this.dispose()
    this.events.failure('The document display scale changed')
  }

  private displayIsCurrent(): boolean {
    if (this.closed) return false
    if (this.resolution?.matches !== false) return true
    this.displayChanged()
    return false
  }

  private isCurrentViewportReply(data: ViewportRequestStamp): boolean {
    return (
      data.revision === this.revision &&
      data.publication === this.active?.publication &&
      data.sequence === this.sequence
    )
  }

  private receive = ({ data }: MessageEvent<LayoutReply>): void => {
    if (!this.displayIsCurrent()) return
    switch (data.type) {
      case 'source':
        if (this.events.source) this.events.source(data, this.lifetime.signal)
        else void data.blocks.cancel().catch(() => {})
        return
      case 'layout':
        if (data.revision !== this.revision || data.publication <= this.latestPublication) return
        this.latestPublication = data.publication
        this.active = data
        this.events.layout(data, data.publication)
        return
      case 'invalidated':
        if (data.publication <= this.latestPublication) return
        this.latestPublication = data.publication
        this.clear()
        return
      case 'viewport':
        if (data.content && this.isCurrentViewportReply(data))
          this.events.viewport({ ...data, content: data.content })
        return
      case 'reveal-unavailable':
        if (this.isCurrentViewportReply(data)) this.events.revealUnavailable(data.position)
        return
      case 'failure':
        this.dispose()
        this.events.failure(data.reason)
        return
    }
  }
}

/** The caller supplies an owned snapshot of file bytes and the canvas size. */
export function connectDesktopLayout(
  open: Extract<LayoutMessage, { type: 'open' }>,
  events: LayoutClientEvents,
): LayoutClient {
  const { port1, port2 } = new MessageChannel()
  const expectedScale = window.devicePixelRatio
  const resolution = window.matchMedia(`(resolution: ${expectedScale}dppx)`)
  const client = new LayoutClient(port1, events, resolution)
  try {
    // Clone the owned input before asking the preload to create a worker.
    port1.postMessage({ ...open, includeSource: !!events.source }, [open.file.data])
    window.postMessage(
      {
        type: 'docs:connect-layout',
        width: window.innerWidth,
        height: window.innerHeight,
        expectedScale,
      },
      '*',
      [port2],
    )
  } catch (error) {
    client.dispose()
    port2.close()
    throw error
  }
  return client
}
