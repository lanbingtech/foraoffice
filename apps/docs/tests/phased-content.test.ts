import { describe, expect, it } from 'vitest'
import type { PmNode } from '../src/renderer/editor/convert'
import {
  PHASED_CONTENT_SETTLED_EVENT,
  PAINTED_FRAME_FALLBACK_MS,
  PHASE1_BLOCKS,
  PHASE_CHUNK_BLOCKS,
  PHASED_MIN_BLOCKS,
  cancelPhasedContent,
  isPhasedContentPending,
  setContentPhased,
  unmountedSourceBlocksOf,
  waitForFullContent,
  type PhasedContentHost,
} from '../src/renderer/phased-content'

const docOf = (blocks: number): PmNode => ({
  type: 'doc',
  content: Array.from({ length: blocks }, (_, i) => ({
    type: 'docParagraph',
    attrs: { docxIndex: i },
  })),
})

/** host that records events; appends mark dirty like the editor's onUpdate does */
function makeHost(destroyed = false) {
  const state = {
    mounted: [] as PmNode[],
    events: [] as string[],
    dirty: false,
    loading: false,
  }
  const host: PhasedContentHost = {
    setContent: (d) => {
      state.mounted = [...(d.content ?? [])]
      state.events.push(`set:${state.mounted.length}`)
    },
    appendNodes: (nodes) => {
      state.mounted.push(...nodes)
      state.dirty = true
      state.events.push(`append:${nodes.length}`)
    },
    isDestroyed: () => destroyed,
    resetHistory: () => state.events.push('resetHistory'),
    setLoading: (v) => {
      state.loading = v
      state.events.push(`loading:${v}`)
    },
    getDirty: () => state.dirty,
    setDirty: (v) => {
      state.dirty = v
    },
  }
  return { host, state }
}

/** scheduler the test drains manually, one chunk per drain() call */
function makeScheduler() {
  const queue: Array<() => void> = []
  return {
    schedule: (cb: () => void) => queue.push(cb),
    drain: () => queue.shift()?.(),
    pending: () => queue.length,
  }
}

describe('setContentPhased', () => {
  it('tracks unmounted source blocks for the owning editor across appends and cancellation', () => {
    const { host } = makeHost()
    const owner = {}
    const other = {}
    const scheduler = makeScheduler()
    setContentPhased({ ...host, owner }, docOf(PHASED_MIN_BLOCKS + 20), scheduler.schedule, () => 0)
    expect(unmountedSourceBlocksOf(owner)?.(PHASE1_BLOCKS - 1)).toBe(false)
    expect(unmountedSourceBlocksOf(owner)?.(PHASE1_BLOCKS)).toBe(true)
    expect(unmountedSourceBlocksOf(other)).toBeUndefined()
    scheduler.drain()
    expect(unmountedSourceBlocksOf(owner)?.(PHASE1_BLOCKS)).toBe(false)
    expect(unmountedSourceBlocksOf(owner)?.(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS)).toBe(true)
    cancelPhasedContent()
    expect(unmountedSourceBlocksOf(owner)).toBeUndefined()
    scheduler.drain()
  })

  it('mounts small documents in one pass without the loading flag', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(state.events).toEqual([`set:${PHASED_MIN_BLOCKS}`])
    expect(s.pending()).toBe(0)
  })

  it('streams a large document in chunks and lands the full content', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2 + 7
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    expect(state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(state.loading).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    // every block landed exactly once, in order
    expect(state.mounted.map((n) => n.attrs?.docxIndex)).toEqual(
      Array.from({ length: blocks }, (_, i) => i),
    )
    expect(state.loading).toBe(false)
    expect(state.events).toContain('resetHistory')
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('streaming is not an edit: the dirty flag survives every chunk', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 50), s.schedule)
    while (s.pending() > 0) s.drain()
    expect(state.dirty).toBe(false)
  })

  it('reduces the next append workload after a slow batch without dropping content', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    let now = 0
    const append = host.appendNodes
    host.appendNodes = (nodes) => {
      append(nodes)
      now += nodes.length / 2
    }
    setContentPhased(host, docOf(total), scheduler.schedule, () => now)
    scheduler.drain()
    scheduler.drain()
    const appends = state.events.filter((event) => event.startsWith('append:'))
    expect(appends[0]).toBe(`append:${PHASE_CHUNK_BLOCKS}`)
    expect(Number(appends[1].split(':')[1])).toBeLessThan(PHASE_CHUNK_BLOCKS)
    expect(state.loading).toBe(true)
    while (scheduler.pending() > 0) scheduler.drain()
    expect(state.mounted.map((node) => node.attrs?.docxIndex)).toEqual(
      Array.from({ length: total }, (_, i) => i),
    )
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it.each([
    { delay: PAINTED_FRAME_FALLBACK_MS, reduced: false },
    { delay: 850, reduced: true },
  ])('sizes the next append after a $delay ms frame wait', ({ delay, reduced }) => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    let now = 0
    const append = host.appendNodes
    host.appendNodes = (nodes) => {
      append(nodes)
      now += 5
    }
    setContentPhased(
      host,
      docOf(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3),
      scheduler.schedule,
      () => now,
    )
    scheduler.drain()
    now += delay
    scheduler.drain()
    const appends = state.events.filter((event) => event.startsWith('append:'))
    expect(appends[0]).toBe(`append:${PHASE_CHUNK_BLOCKS}`)
    expect(Number(appends[1].split(':')[1]) < PHASE_CHUNK_BLOCKS).toBe(reduced)
    cancelPhasedContent()
  })

  it('cancelPhasedContent drops the pending tail and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    s.drain() // first chunk lands
    const landed = state.mounted.length
    cancelPhasedContent()
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(landed)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('a second phased mount cancels the first tail', () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const first = makeHost()
    const s1 = makeScheduler()
    setContentPhased(first.host, docOf(blocks), s1.schedule)
    const second = makeHost()
    const s2 = makeScheduler()
    setContentPhased(second.host, docOf(blocks), s2.schedule)
    while (s1.pending() > 0) s1.drain()
    while (s2.pending() > 0) s2.drain()
    // the first document keeps only its phase-1 mount; the second is complete
    expect(first.state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(second.state.mounted.length).toBe(blocks)
    expect(first.state.loading).toBe(false)
    expect(second.state.loading).toBe(false)
  })

  it('a rejected chunk falls back to the one-pass mount and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    const { host, state } = makeHost()
    const { appendNodes, setContent } = host
    let appends = 0
    host.appendNodes = (nodes) => {
      if (++appends === 2) throw new Error('schema refused')
      appendNodes(nodes)
    }
    host.setContent = (d) => {
      setContent(d)
      state.dirty = true
    }
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    state.dirty = false
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    expect(state.events.at(-3)).toBe(`set:${blocks}`)
    // the remount is not an edit either
    expect(state.dirty).toBe(false)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('reports a pending tail only while chunks remain', () => {
    const { host } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    expect(isPhasedContentPending()).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    cancelPhasedContent()
    expect(isPhasedContentPending()).toBe(false)
  })

  it('announces the settled tail on document, and only then', () => {
    const { host } = makeHost()
    const { schedule, drain, pending } = makeScheduler()
    let announced = 0
    const onSettled = () => announced++
    document.addEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    try {
      setContentPhased(host, docOf(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2), schedule)
      expect(announced).toBe(0)
      drain()
      expect(announced).toBe(0)
      drain()
      expect(pending()).toBe(0)
      expect(announced).toBe(1)
      // small documents mount in one pass without a tail: nothing to announce
      setContentPhased(host, docOf(3), schedule)
      expect(announced).toBe(1)
    } finally {
      document.removeEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    }
  })
})
