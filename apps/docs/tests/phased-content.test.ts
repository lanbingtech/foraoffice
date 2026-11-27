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

/** Host that records events without treating appends as edits. */
function makeHost(destroyed = false) {
  let installed: object | undefined
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
    appendNodes: (nodes, attempt) => {
      state.mounted.push(...nodes)
      installed = attempt
      state.events.push(`append:${nodes.length}`)
    },
    appliedAppend: (attempt) => installed === attempt,
    isDestroyed: () => destroyed,
    resetHistory: () => state.events.push('resetHistory'),
    setLoading: (v) => {
      state.loading = v
      state.events.push(`loading:${v}`)
    },
    getDirty: () => state.dirty,
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
  it('streams a short document with a heavy nested table and mounts that table on its own', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    const content = docOf(3).content!
    content[1] = {
      type: 'docTable',
      attrs: { docxIndex: 1 },
      content: [
        {
          type: 'docTableRow',
          content: [
            {
              type: 'docTableCell',
              content: [
                {
                  type: 'docNestedTable',
                  attrs: {
                    model: {
                      rows: Array.from({ length: 110 }, () => [
                        { paras: ['left'] },
                        { paras: ['right'] },
                      ]),
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    setContentPhased(host, { type: 'doc', content }, s.schedule, () => 0)
    expect(state.mounted).toHaveLength(1)
    expect(state.mounted[0]).toBe(content[0])
    expect(state.loading).toBe(true)
    s.drain()
    expect(state.mounted).toHaveLength(2)
    expect(state.mounted[1]).toBe(content[1])
    expect(state.loading).toBe(true)
    s.drain()
    expect(state.mounted).toEqual(content)
    expect(state.loading).toBe(false)
  })

  it('accounts for the editors mounted inside protected textboxes', () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    const content = docOf(100).content!.map((block) => ({
      type: 'docProtected',
      attrs: {
        ...block.attrs,
        textboxes: [{ paras: [{ runs: [{ text: 'text' }] }] }],
      },
    }))

    setContentPhased(host, { type: 'doc', content }, scheduler.schedule, () => 0)

    expect(state.mounted.length).toBeLessThan(content.length)
    while (scheduler.pending()) scheduler.drain()
    expect(state.mounted).toEqual(content)
  })

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
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('mounts the prefix before source delivery and schedules the tail after delivery', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    let release!: (mount: boolean) => void
    host.canMountTail = new Promise<boolean>((resolve) => (release = resolve))
    const document = docOf(PHASED_MIN_BLOCKS + 20)

    setContentPhased(host, document, scheduler.schedule)
    expect(state.mounted).toHaveLength(PHASE1_BLOCKS)
    expect(state.loading).toBe(true)
    expect(scheduler.pending()).toBe(0)
    release(true)
    await host.canMountTail
    expect(scheduler.pending()).toBe(1)
    scheduler.drain()
    expect(scheduler.pending()).toBe(0)
    expect(state.mounted).toEqual(document.content)
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('does not schedule the deferred tail of a replaced document', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    let release!: (mount: boolean) => void
    host.canMountTail = new Promise<boolean>((resolve) => (release = resolve))
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 20), scheduler.schedule)
    const oldDocument = waitForFullContent()

    const replacement = docOf(2)
    setContentPhased(host, replacement, scheduler.schedule)
    release(true)
    await host.canMountTail
    await expect(oldDocument).resolves.toBe(false)
    expect(scheduler.pending()).toBe(0)
    expect(state.mounted).toEqual(replacement.content)
  })

  it('settles an interrupted source handoff without mounting the tail', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    let release!: (mount: boolean) => void
    host.canMountTail = new Promise<boolean>((resolve) => (release = resolve))
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 20), scheduler.schedule)

    release(false)
    await expect(waitForFullContent()).resolves.toBe(false)
    expect(state.mounted).toHaveLength(PHASE1_BLOCKS)
    expect(state.loading).toBe(false)
    expect(scheduler.pending()).toBe(0)
    cancelPhasedContent()
  })

  it('streaming is not an edit: the dirty flag survives every chunk', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 50), s.schedule)
    while (s.pending() > 0) s.drain()
    expect(state.dirty).toBe(false)
  })

  it('keeps a foreground edit made synchronously within a successful append', () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    const append = host.appendNodes
    host.appendNodes = (nodes, attempt) => {
      append(nodes, attempt)
      state.mounted[0] = { type: 'docParagraph', content: [{ type: 'text', text: 'live edit' }] }
      state.dirty = true
    }
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), scheduler.schedule, () => 0)
    while (scheduler.pending()) scheduler.drain()
    expect(state.mounted[0].content?.[0].text).toBe('live edit')
    expect(state.dirty).toBe(true)
    expect(state.events).not.toContain('resetHistory')
  })

  it('reduces the next append workload after a slow batch without dropping content', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    const total = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    let now = 0
    const append = host.appendNodes
    host.appendNodes = (nodes, attempt) => {
      append(nodes, attempt)
      now += nodes.length * 8
    }
    setContentPhased(host, docOf(total), scheduler.schedule, () => now)
    scheduler.drain()
    scheduler.drain()
    const appends = state.events.filter((event) => event.startsWith('append:'))
    expect(appends[0]).toBe(`append:${PHASE_CHUNK_BLOCKS}`)
    expect(Number(appends[1].split(':')[1])).toBeLessThan(16)
    expect(state.loading).toBe(true)
    while (scheduler.pending() > 0) scheduler.drain()
    expect(state.mounted.map((node) => node.attrs?.docxIndex)).toEqual(
      Array.from({ length: total }, (_, i) => i),
    )
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it.each([
    { delay: PAINTED_FRAME_FALLBACK_MS, reduced: false },
    { delay: 850, reduced: true },
  ])('sizes the next append after a $delay ms frame wait', ({ delay, reduced }) => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    let now = 0
    const append = host.appendNodes
    host.appendNodes = (nodes, attempt) => {
      append(nodes, attempt)
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
    const completion = waitForFullContent()
    s.drain() // first chunk lands
    const landed = state.mounted.length
    cancelPhasedContent()
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(landed)
    expect(state.loading).toBe(false)
    await expect(completion).resolves.toBe(false)
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

  it('keeps the replacement pending when it opens during the old history reset', () => {
    const first = makeHost()
    const second = makeHost()
    const owner = {}
    const oldFrames = makeScheduler()
    const newFrames = makeScheduler()
    const blocks = PHASED_MIN_BLOCKS + 1
    first.host.resetHistory = () =>
      setContentPhased({ ...second.host, owner }, docOf(blocks), newFrames.schedule, () => 0)

    try {
      setContentPhased(first.host, docOf(blocks), oldFrames.schedule, () => 0)
      while (oldFrames.pending()) oldFrames.drain()
      expect(isPhasedContentPending()).toBe(true)
      expect(unmountedSourceBlocksOf(owner)?.(PHASE1_BLOCKS)).toBe(true)
      expect(second.state.mounted.length).toBe(PHASE1_BLOCKS)
      while (newFrames.pending()) newFrames.drain()
      expect(second.state.mounted.length).toBe(blocks)
    } finally {
      cancelPhasedContent()
    }
  })

  it('cancels old output waiters when clearing loading starts a replacement', async () => {
    const first = makeHost()
    const second = makeHost()
    const oldFrames = makeScheduler()
    const newFrames = makeScheduler()
    const blocks = PHASED_MIN_BLOCKS + 1
    first.host.setLoading = (loading) => {
      if (!loading) setContentPhased(second.host, docOf(blocks), newFrames.schedule, () => 0)
    }

    setContentPhased(first.host, docOf(blocks), oldFrames.schedule, () => 0)
    const completion = waitForFullContent()
    while (oldFrames.pending()) oldFrames.drain()
    await expect(completion).resolves.toBe(false)
    expect(isPhasedContentPending()).toBe(true)
    while (newFrames.pending()) newFrames.drain()
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('holds the save gate for the winning stream when the first mount starts another open', async () => {
    const first = makeHost()
    const second = makeHost()
    const oldFrames = makeScheduler()
    const newFrames = makeScheduler()
    const blocks = PHASED_MIN_BLOCKS + 1
    first.host.setContent = () =>
      setContentPhased(second.host, docOf(blocks), newFrames.schedule, () => 0)

    try {
      setContentPhased(first.host, docOf(blocks), oldFrames.schedule, () => 0)
      expect(oldFrames.pending()).toBe(0)
      expect(first.state.loading).toBe(false)
      let gateOpened = false
      const gate = waitForFullContent()
      void gate.then(() => (gateOpened = true))
      await Promise.resolve()
      expect(gateOpened).toBe(false)
      while (newFrames.pending()) newFrames.drain()
      await expect(gate).resolves.toBe(true)
      expect(gateOpened).toBe(true)
      expect(second.state.mounted.length).toBe(blocks)
    } finally {
      cancelPhasedContent()
    }
  })

  it('drops an old append failure after the same editor starts opening a new document', () => {
    const { host, state } = makeHost()
    const oldFrames = makeScheduler()
    const newFrames = makeScheduler()
    const blocks = PHASED_MIN_BLOCKS + 2
    const { appendNodes } = host
    host.appendNodes = () => {
      host.appendNodes = appendNodes
      setContentPhased(host, docOf(blocks), newFrames.schedule, () => 0)
      state.dirty = true
      throw new Error('The superseded append was refused')
    }

    try {
      setContentPhased(host, docOf(blocks + 1), oldFrames.schedule, () => 0)
      oldFrames.drain()
      expect(state.mounted.length).toBe(PHASE1_BLOCKS)
      expect(state.dirty).toBe(true)
      expect(isPhasedContentPending()).toBe(true)
      while (newFrames.pending()) newFrames.drain()
      expect(state.mounted.length).toBe(blocks)
      expect(state.dirty).toBe(true)
    } finally {
      cancelPhasedContent()
    }
  })

  it('a rejected chunk appends the missing suffix and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    const { host, state } = makeHost()
    const { appendNodes } = host
    let appends = 0
    host.appendNodes = (nodes, attempt) => {
      if (++appends === 2) throw new Error('schema refused')
      appendNodes(nodes, attempt)
    }
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    state.dirty = false
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    expect(state.events.filter((event) => event.startsWith('set:'))).toEqual([
      `set:${PHASE1_BLOCKS}`,
    ])
    expect(appends).toBe(3)
    expect(state.events).toContain('resetHistory')
    expect(state.dirty).toBe(false)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it.each([false, true])(
    'preserves live edits during a failed append (chunk installed: %s)',
    async (mounted) => {
      const { host, state } = makeHost()
      const scheduler = makeScheduler()
      const original = docOf(PHASED_MIN_BLOCKS + PHASE_CHUNK_BLOCKS)
      setContentPhased(host, original, scheduler.schedule, () => 0)
      scheduler.drain()

      const edited = { ...state.mounted[0], content: [{ type: 'text', text: 'live edit' }] }
      const append = host.appendNodes
      host.appendNodes = (nodes, attempt) => {
        host.appendNodes = append
        if (mounted) append(nodes, attempt)
        state.mounted[0] = edited
        state.dirty = true
        throw new Error('append failed')
      }

      while (scheduler.pending()) scheduler.drain()
      expect(state.mounted).toEqual([edited, ...original.content!.slice(1)])
      expect(state.dirty).toBe(true)
      expect(state.loading).toBe(false)
      expect(state.events).not.toContain('resetHistory')
      await expect(waitForFullContent()).resolves.toBe(true)
    },
  )

  it('reports failed completion when neither append can install the tail', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    host.appendNodes = () => {
      throw new Error('append failed')
    }
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), scheduler.schedule, () => 0)
    const completion = waitForFullContent()
    while (scheduler.pending()) scheduler.drain()
    expect(state.mounted).toHaveLength(PHASE1_BLOCKS)
    expect(state.loading).toBe(false)
    expect(isPhasedContentPending()).toBe(false)
    await expect(completion).resolves.toBe(false)
    await expect(waitForFullContent()).resolves.toBe(false)
  })

  it('keeps output blocked until a replacement actually mounts', async () => {
    const { host } = makeHost()
    const scheduler = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), scheduler.schedule, () => 0)
    const failure = new Error('mount failed')
    expect(() =>
      setContentPhased(
        {
          ...host,
          setContent: () => {
            throw failure
          },
        },
        docOf(1),
        scheduler.schedule,
      ),
    ).toThrow(failure)
    await expect(waitForFullContent()).resolves.toBe(false)

    setContentPhased(host, docOf(1), scheduler.schedule)
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('blocks output when the initial mount installs a prefix and then throws', async () => {
    const { host, state } = makeHost()
    const scheduler = makeScheduler()
    const failure = new Error('mount failed')
    const set = host.setContent
    host.setContent = (doc) => {
      set(doc)
      throw failure
    }
    expect(() => setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), scheduler.schedule)).toThrow(
      failure,
    )
    expect(state.mounted).toHaveLength(PHASE1_BLOCKS)
    await expect(waitForFullContent()).resolves.toBe(false)
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
