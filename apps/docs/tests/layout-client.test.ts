import { Extension, Node } from '@tiptap/core'
import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import { presentationPlugin, type AuthoredDocument } from '../src/renderer/editor/authored-document'
import type { PmNode } from '../src/renderer/editor/convert'
import {
  LayoutClient,
  type LayoutMessage,
  type LayoutReply,
} from '../src/renderer/editor/layout-client'

class TestPort extends EventTarget {
  readonly sent: LayoutMessage[] = []
  closed = false
  start() {}

  close() {
    this.closed = true
  }

  postMessage(message: LayoutMessage) {
    this.sent.push(message)
  }

  receive(data: LayoutReply) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function client(resolution?: MediaQueryList, plugins: readonly Plugin[] = []) {
  const port = new TestPort()
  const events = {
    layout: vi.fn(),
    viewport: vi.fn(),
    revealUnavailable: vi.fn(),
    failure: vi.fn(),
    source: {
      extensions: [
        Node.create({ name: 'doc', topNode: true, content: 'paragraph' }),
        Node.create({ name: 'paragraph', content: 'text*' }),
        Node.create({ name: 'text' }),
        Extension.create({ name: 'testPlugins', addProseMirrorPlugins: () => [...plugins] }),
      ],
      opened: vi.fn<(document: AuthoredDocument) => void>(),
    },
    initialViewport: vi.fn(),
  }
  const layout = new LayoutClient(port as unknown as MessagePort, events, resolution)
  return { port, events, layout }
}

describe('the authoritative layout connection', () => {
  it('opens model-only state and sends the entire accepted source transaction chain', async () => {
    const init = vi.fn()
    const presentation = presentationPlugin({ state: { init, apply: () => undefined } })
    const authored = new Plugin({
      appendTransaction: (chain, _old, state) =>
        chain.some((transaction) => transaction.getMeta('complete'))
          ? state.tr.insertText('!', state.doc.content.size - 1)
          : null,
    })
    const { layout, port, events } = client(undefined, [presentation, authored])
    port.receive({
      type: 'source',
      revision: 0,
      root: { type: 'doc' },
      blocks: new ReadableStream({
        start(controller) {
          controller.enqueue([{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }])
          controller.close()
        },
      }),
    })
    await vi.waitFor(() => expect(events.source.opened).toHaveBeenCalledTimes(1))
    expect(init).not.toHaveBeenCalled()
    const owner = events.source.opened.mock.calls[0][0]
    expect(owner.read().state.doc.textContent).toBe('body')
    expect(owner.read().revision).toBe(0)
    expect(owner.read().state.plugins).toContain(authored)
    expect(owner.read().state.plugins).not.toContain(presentation)
    const accepted = owner.dispatch(
      owner.read().state.tr.insertText('test ', 1).setMeta('complete', true),
    )
    expect(owner.read().state.doc.textContent).toBe('test body!')
    expect(owner.read().revision).toBe(1)
    expect(accepted).toHaveLength(2)
    expect(port.sent).toEqual([
      {
        type: 'edit',
        fromRevision: 0,
        toRevision: 1,
        steps: accepted.flatMap((transaction) => transaction.steps.map((step) => step.toJSON())),
      },
    ])
    owner.destroy()
    layout.dispose()
  })

  it('aborts the source reader when the connection retires', async () => {
    const { layout, port, events } = client()
    const cancel = vi.fn()
    port.receive({
      type: 'source',
      revision: 0,
      root: { type: 'doc' },
      blocks: new ReadableStream<PmNode[]>({ cancel }),
    })
    layout.dispose()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(events.source.opened).not.toHaveBeenCalled()
    expect(events.failure).not.toHaveBeenCalled()
  })

  it('delivers the initial viewport before a complete publication or any edit', () => {
    const { layout, port, events } = client()
    const content = { canvas: { left: 0, top: 0, width: 80, height: 100 }, blocks: [] }
    const initial = { type: 'initial-viewport' as const, content, revision: 0 as const }
    port.receive(initial)
    port.receive(initial)
    port.receive({ type: 'layout', pages: [], publication: 1, revision: 0 })
    port.receive(initial)
    expect(events.initialViewport.mock.calls).toEqual([[initial], [null]])

    const edited = client()
    const schema = new Schema({
      nodes: { doc: { content: 'paragraph' }, paragraph: { content: 'text*' }, text: {} },
    })
    edited.port.receive(initial)
    edited.layout.apply([EditorState.create({ schema }).tr.insertText('text', 1)])
    edited.port.receive(initial)
    expect(edited.events.initialViewport.mock.calls).toEqual([[initial], [null]])
    layout.dispose()
    edited.layout.dispose()
  })

  it('retires published geometry at a display scale change before handling pending messages', () => {
    const resolution = Object.assign(new EventTarget(), { matches: true })
    const { layout, port, events } = client(resolution as unknown as MediaQueryList)
    port.receive({ type: 'layout', pages: [], publication: 3, revision: 0 })

    resolution.matches = false
    port.receive({ type: 'layout', pages: [], publication: 4, revision: 0 })
    layout.request({ top: 0, bottom: 40 })
    resolution.dispatchEvent(new Event('change'))

    expect(events.layout.mock.calls).toEqual([
      [expect.objectContaining({ publication: 3 }), 3],
      [null, 3],
    ])
    expect(port.closed).toBe(true)
    expect(port.sent).toHaveLength(0)
    expect(events.failure).toHaveBeenCalledExactlyOnceWith('The document display scale changed')
  })

  it('drops superseded scroll replies and invalidates same-revision stale geometry', () => {
    const { layout, port, events } = client()
    const content = { canvas: { left: 0, top: 0, width: 80, height: 100 }, blocks: [] }
    port.receive({ type: 'layout', pages: [], publication: 1, revision: 0 })
    layout.request({ top: 0, bottom: 10 })
    layout.request({ top: 30, bottom: 40 })
    port.receive({ type: 'viewport', revision: 0, sequence: 1, publication: 1, content })
    port.receive({ type: 'viewport', revision: 0, sequence: 2, publication: 1, content })
    expect(events.viewport).toHaveBeenCalledTimes(1)
    port.receive({ type: 'invalidated', publication: 2 })
    expect(events.layout).toHaveBeenLastCalledWith(null, 2)
    port.receive({ type: 'layout', pages: [], publication: 1, revision: 0 })
    layout.request({ top: 80, bottom: 90 })
    expect(port.sent).toHaveLength(2)
  })

  it('uses the measured owner position and discards a reveal superseded by scrolling', () => {
    const { layout, port, events } = client()
    const content = { canvas: { left: 0, top: 0, width: 80, height: 500 }, blocks: [] }
    expect(layout.requestReveal(20, 80, 0)).toBe(false)
    port.receive({ type: 'layout', pages: [], publication: 1, revision: 0 })
    expect(layout.requestReveal(-1, 80, 0)).toBe(false)
    expect(layout.requestReveal(20, 80, 1)).toBe(false)
    expect(layout.requestReveal(20, 80, 0)).toBe(true)
    expect(port.sent.at(-1)).toEqual({
      type: 'reveal',
      sequence: 1,
      publication: 1,
      revision: 0,
      position: 20,
      height: 80,
    })
    const reply = {
      type: 'viewport' as const,
      revision: 0,
      publication: 1,
      sequence: 1,
      reveal: { position: 20, top: 200 },
      content,
    }
    layout.request({ top: 30, bottom: 110 })
    port.receive(reply)
    expect(events.viewport).not.toHaveBeenCalled()
    expect(layout.requestReveal(20, 80, 0)).toBe(true)
    port.receive({ ...reply, sequence: 3 })
    expect(events.viewport).toHaveBeenCalledExactlyOnceWith({ ...reply, sequence: 3 })

    expect(layout.requestReveal(600, 80, 0)).toBe(true)
    const unavailable = {
      type: 'reveal-unavailable' as const,
      revision: 0,
      sequence: 4,
      publication: 1,
      position: 600,
    }
    port.receive({ ...unavailable, publication: 0 })
    expect(events.revealUnavailable).not.toHaveBeenCalled()
    port.receive(unavailable)
    expect(events.revealUnavailable).toHaveBeenCalledExactlyOnceWith(600)
  })

  it('waits for layouts of the most recent authoritative input revision', () => {
    const { layout, port, events } = client()
    const schema = new Schema({
      nodes: { doc: { content: 'paragraph' }, paragraph: { content: 'text*' }, text: {} },
    })
    const state = EditorState.create({ schema })
    port.receive({ type: 'layout', pages: [], publication: 1, revision: 0 })
    layout.apply([state.tr.insertText('test', 1)])
    expect(port.sent.at(-1)).toMatchObject({ type: 'edit', fromRevision: 0, toRevision: 1 })
    port.receive({ type: 'layout', pages: [], publication: 2, revision: 0 })
    expect(events.layout).toHaveBeenLastCalledWith(null, 1)
    port.receive({ type: 'layout', pages: [], publication: 3, revision: 1 })
    expect(events.layout).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }), 3)
    port.receive({ type: 'failure', reason: 'Rejected' })
    expect(port.closed).toBe(true)
    expect(events.failure).toHaveBeenCalledWith('Rejected')
  })

  it('reads the visible placements synchronously once an index is published', () => {
    const { layout, port, events } = client()
    const canvas = { left: 0, top: 0, width: 80, height: 360 }
    const block = { from: 40, to: 45, box: { left: 3, top: 200, width: 20, height: 10 } }
    port.receive({
      type: 'layout',
      pages: [],
      publication: 8,
      revision: 0,
      geometry: { canvas, blocks: [{ placement: block, through: 210 }] },
    })
    layout.request({ top: 200, bottom: 210 })
    expect(port.sent).toHaveLength(0)
    expect(events.viewport).toHaveBeenCalledWith({
      type: 'viewport',
      publication: 8,
      revision: 0,
      sequence: 1,
      content: { canvas, blocks: [block] },
    })
  })

  it('keeps invisible source atoms between visible placements', () => {
    const { layout, port, events } = client()
    const canvas = { left: 0, top: 0, width: 80, height: 360 }
    const before = { from: 5, to: 15, box: { left: 3, top: 200, width: 20, height: 10 } }
    const after = { from: 16, to: 26, box: { left: 3, top: 212, width: 20, height: 10 } }
    const empty = { from: 15, to: 16, box: { left: 3, top: 230, width: 20, height: 0 } }
    port.receive({
      type: 'layout',
      pages: [],
      publication: 8,
      revision: 0,
      geometry: {
        canvas,
        blocks: [
          { placement: before, through: 210 },
          { placement: after, through: 222 },
          { placement: empty, through: 230 },
        ],
        empty: { 15: empty },
      },
    })
    layout.request({ top: 200, bottom: 222 })
    expect(events.viewport.mock.calls[0][0].content.blocks).toEqual([
      before,
      { ...empty, hidden: true },
      after,
    ])
  })

  it('selects anchored content using its painted bounds, ahead of its zero-height wrapper', () => {
    const { layout, port, events } = client()
    const canvas = { left: 0, top: 0, width: 80, height: 360 }
    const float = { from: 5, to: 6, box: { left: 3, top: 230, width: 20, height: 0 } }
    port.receive({
      type: 'layout',
      pages: [],
      publication: 8,
      revision: 0,
      geometry: {
        canvas,
        blocks: [
          { placement: float, ink: { left: 3, top: 200, width: 20, height: 15 }, through: 215 },
        ],
      },
    })
    layout.request({ top: 200, bottom: 210 })
    expect(events.viewport.mock.calls[0][0].content.blocks).toEqual([float])
  })
})
