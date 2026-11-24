import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
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

function client(resolution?: MediaQueryList) {
  const port = new TestPort()
  const events = {
    layout: vi.fn(),
    viewport: vi.fn(),
    revealUnavailable: vi.fn(),
    failure: vi.fn(),
  }
  const layout = new LayoutClient(port as unknown as MessagePort, events, resolution)
  return { port, events, layout }
}

describe('the authoritative layout connection', () => {
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
