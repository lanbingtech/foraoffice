import type { Lang } from '@genoffice/i18n'
import type { Transaction } from '@tiptap/pm/state'
import type { OpenFileResult } from '../../shared/ipc'
import type { PageCut } from '../pagination-cuts'
import type { ViewportBounds } from './viewport-fragments'
import { viewportContent, type ViewportContent, type ViewportGeometry } from './viewport-layout'

export type LayoutMessage =
  | {
      type: 'open'
      file: OpenFileResult & { data: ArrayBuffer }
      language: Lang
      width: number
      height: number
    }
  | { type: 'viewport'; sequence: number; publication: number; bounds: ViewportBounds }
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

type ViewportPublication = {
  type: 'viewport'
  publication: number
  revision: number
  sequence: number
  content: ViewportContent | null
}

export type LayoutReply =
  | LayoutPublication
  | { type: 'invalidated'; publication: number }
  | { type: 'applied'; revision: number }
  | ViewportPublication
  | { type: 'failure'; reason: string }

interface LayoutClientEvents {
  layout(layout: LayoutPublication | null, publication: number): void
  viewport(reply: ViewportPublication & { content: ViewportContent }): void
  failure(reason: string): void
}

export class LayoutClient {
  private revision = 0
  private sequence = 0
  private latestPublication = 0
  private active?: LayoutPublication
  private closed = false

  constructor(
    private readonly port: MessagePort,
    private readonly events: LayoutClientEvents,
  ) {
    port.addEventListener('message', this.receive)
    port.addEventListener('close', this.lost, { once: true })
    port.start()
  }

  request(bounds: ViewportBounds): void {
    if (this.closed || !this.active) return
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

  apply(transactions: readonly Transaction[]): void {
    if (this.closed) return
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
    this.port.removeEventListener('message', this.receive)
    this.port.removeEventListener('close', this.lost)
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

  private receive = ({ data }: MessageEvent<LayoutReply>): void => {
    if (this.closed) return
    switch (data.type) {
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
        if (
          data.content &&
          data.revision === this.revision &&
          data.publication === this.active?.publication &&
          data.sequence === this.sequence
        )
          this.events.viewport({ ...data, content: data.content })
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
  window.postMessage(
    { type: 'docs:connect-layout', width: window.innerWidth, height: window.innerHeight },
    '*',
    [port2],
  )
  const client = new LayoutClient(port1, events)
  port1.postMessage(open, [open.file.data])
  return client
}
