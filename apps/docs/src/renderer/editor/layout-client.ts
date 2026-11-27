import type { Lang } from '@genoffice/i18n'
import type { Editor, Extensions } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import type { OpenFileResult } from '../../shared/ipc'
import type { PageCut } from '../pagination-cuts'
import { AuthoredDocument, AuthoredEditor, readImportedBody } from './authored-document'
import type { PmNode } from './convert'
import type { TocPageDisplay } from './toc-refresh'
import type { ViewportBounds } from './viewport-fragments'
import type { ViewportTableRowFragment } from './viewport-table-source'
import {
  viewportContent,
  type ViewportContent,
  type ViewportGeometry,
  type ViewportPageFrame,
  type ViewportReveal,
  type ViewportRevealScope,
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
  | { type: 'opening-demand'; publication: number; bottom: number }
  | (ViewportRequestStamp & {
      type: 'reveal'
      position: number
      height: number
      scope?: ViewportRevealScope
    })
  | { type: 'edit'; fromRevision: number; toRevision: number; steps: unknown[] }

export interface ViewportLayoutDetails {
  tocPages?: readonly TocPageDisplay[]
  tableFragments?: readonly ViewportTableRowFragment[]
}

type LayoutPublication = ViewportLayoutDetails & {
  type: 'layout'
  publication: number
  revision: number
  pages: readonly PageCut[]
  starts?: readonly (number | null)[]
  pageFrames?: readonly ViewportPageFrame[]
  geometry?: ViewportGeometry
  initial?: ViewportContent
  opening?: true
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
  /** A scroll surface can keep a committed geometry while the same source is remeasured. */
  retainCommittedViewport?(publication: number): boolean
  source?: {
    extensions: Extensions
    configure?(editor: Editor): void
    opened(document: AuthoredDocument): void
  }
  layout(layout: LayoutPublication | null, publication: number): void
  viewport(reply: ViewportPublication & { content: ViewportContent }): void
  revealUnavailable(position: number): void
  failure(reason: string): void
}

export class LayoutClient {
  private revision = 0
  private sequence = 0
  private requestedOpening = 0
  private openingRange?: { publication: number; bottom: number }
  private latestPublication = 0
  private active?: LayoutPublication
  private sourceReceived = false
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

  requestOpening(bounds: ViewportBounds): void {
    const opening = this.openingRange
    if (!this.displayIsCurrent() || !opening || bounds.top <= 0) return
    const height = bounds.bottom - bounds.top
    if (
      opening.bottom - bounds.bottom >= height * 2 ||
      this.requestedOpening === opening.publication
    )
      return
    this.requestedOpening = opening.publication
    this.send({
      type: 'opening-demand',
      publication: opening.publication,
      bottom: opening.bottom + height * 2,
    })
  }

  request(bounds: ViewportBounds): void {
    if (!this.displayIsCurrent() || !this.active) return
    const { geometry, publication, revision } = this.active
    const sequence = ++this.sequence
    if (geometry) {
      this.requestOpening(bounds)
      if (this.active.opening && bounds.top >= geometry.canvas.height) return
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
  requestReveal(
    position: number,
    height: number,
    revision: number,
    scope?: ViewportRevealScope,
  ): boolean {
    if (
      !this.displayIsCurrent() ||
      !this.active ||
      this.active.opening ||
      this.active.publication !== this.latestPublication ||
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
      ...(scope ? { scope } : {}),
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
      data.publication === this.latestPublication &&
      data.sequence === this.sequence
    )
  }

  private receiveSource(data: ImportedSource): void {
    const source = this.events.source
    if (!source || this.sourceReceived) {
      void data.blocks.cancel().catch(() => {})
      return
    }
    this.sourceReceived = true
    void this.openSource(data, source)
  }

  private async openSource(
    data: ImportedSource,
    source: NonNullable<LayoutClientEvents['source']>,
  ): Promise<void> {
    let owner: AuthoredEditor | undefined
    try {
      owner = new AuthoredEditor(source.extensions)
      source.configure?.(owner)
      const doc = await readImportedBody(data.root, data.blocks, owner.schema, this.lifetime.signal)
      if (!this.displayIsCurrent() || this.revision !== data.revision) return
      source.opened(new AuthoredDocument(owner, doc, (chain) => this.apply(chain)))
      owner = undefined
    } catch (reason) {
      if (this.closed) return
      this.dispose()
      this.events.failure(String(reason))
    } finally {
      owner?.destroy()
    }
  }

  private receive = ({ data }: MessageEvent<LayoutReply>): void => {
    if (!this.displayIsCurrent()) return
    switch (data.type) {
      case 'source':
        this.receiveSource(data)
        return
      case 'layout':
        if (data.revision !== this.revision || data.publication <= this.latestPublication) return
        this.latestPublication = data.publication
        this.active = data
        this.openingRange =
          data.opening && data.geometry
            ? { publication: data.publication, bottom: data.geometry.canvas.height }
            : undefined
        this.events.layout(data, data.publication)
        return
      case 'invalidated':
        if (data.publication <= this.latestPublication) return
        this.latestPublication = data.publication
        // Geometry already committed to the foreground is an immutable snapshot.
        // It remains usable for local scroll until a new snapshot supersedes it.
        if (this.active?.geometry && this.events.retainCommittedViewport?.(this.active.publication))
          return
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
