import type { Run, TableModel, TextboxDisplay } from '@genoffice/docx-engine'
import type { PmNode } from './editor/convert'

/**
 * Word-style progressive open for large documents.
 *
 * Mounting a 60-page document in one setContent keeps the "Opening…" screen up
 * until the whole ProseMirror DOM is built and laid out — the dominant share of
 * cold-open time. Instead, mount enough blocks to overfill the first screens,
 * let the browser paint them, then append the tail in frame-sized chunks while
 * the user already reads page 1 (the page count in the status bar grows as the
 * tail streams in, like Word's background pagination).
 *
 * While the tail streams the document is incomplete, so:
 * - the editor stays editable except at the append boundary (the streaming
 *   tail guard refuses edits in or after the last mounted block),
 * - saves must wait on waitForFullContent() — a mid-stream save would
 *   serialize, and write to disk, a truncated document,
 * - appends bypass undo history and leave the dirty flag alone. History resets
 *   after a clean open with no foreground edits.
 */
export interface PhasedContentHost {
  /** The editor whose source indices this stream owns. */
  owner?: object
  /** Wait for the initial source producer to release or cancel the tail mount. */
  canMountTail?: Promise<boolean>
  /** full replace (Tiptap setContent) */
  setContent(doc: PmNode): void
  /** append top-level nodes at the document end, outside undo history */
  appendNodes(nodes: PmNode[], attempt: object): void
  /** Check the installed editor state, even when an observer threw during dispatch. */
  appliedAppend(attempt: object): boolean
  isDestroyed(): boolean
  resetHistory(): void
  /** Loading flag while the tail streams. */
  setLoading(loading: boolean): void
  getDirty(): boolean
  onFailure?(error: unknown): void
}

/** dispatched on document once a streamed tail has fully landed (layout
 *  measurers skip the tail's chunks and measure the whole document once) */
export const PHASED_CONTENT_SETTLED_EVENT = 'genoffice:phased-content-settled'
/** Carries the editor whose mount ended with missing source blocks. */
export const PHASED_CONTENT_FAILED_EVENT = 'genoffice:phased-content-failed'

/** Maximum ordinary blocks in the first synchronous mount. */
export const PHASE1_BLOCKS = 64
/** Maximum ordinary blocks appended in one scheduled chunk. */
export const PHASE_CHUNK_BLOCKS = 128
/** Reserve part of the task budget for painting and queued input. */
const PHASE_APPEND_BUDGET_MS = 24
/** Documents with at most this much ordinary content mount in one pass. */
export const PHASED_MIN_BLOCKS = 192
const ORDINARY_BLOCK_WORK = 4
const SINGLE_MOUNT_WORK = PHASED_MIN_BLOCKS * ORDINARY_BLOCK_WORK
const MAX_APPEND_WORK = PHASE_CHUNK_BLOCKS * ORDINARY_BLOCK_WORK
const CHARS_PER_MOUNT_WORK = 128

function textMountWork(text: string | undefined): number {
  return Math.floor((text?.length ?? 0) / CHARS_PER_MOUNT_WORK)
}

function runsMountWork(runs: readonly Run[], limit: number): number {
  let work = 1
  for (const run of runs) {
    work += 1 + textMountWork(run.text)
    if (work >= limit) return limit
  }
  return Math.min(work, limit)
}

function nestedTableMountWork(table: TableModel, limit: number): number {
  let work = 1 + (table.colWidthsPct?.length ?? 0)
  for (const row of table.rows) {
    if (++work >= limit) return limit
    for (const cell of row) {
      if (++work >= limit) return limit
      if (cell.vMerge === 'continue') continue
      if (cell.richParas?.length) {
        for (const para of cell.richParas) {
          work += runsMountWork(para.runs, limit - work)
          if (work >= limit) return limit
        }
      } else {
        for (const para of cell.paras) {
          work += 1 + textMountWork(para)
          if (work >= limit) return limit
        }
      }
      for (const nested of cell.nestedTables ?? []) {
        work += nestedTableMountWork(nested, limit - work)
        if (work >= limit) return limit
      }
      if (cell.anchoredBoxes?.length) {
        work += textboxMountWork(cell.anchoredBoxes, limit - work)
        if (work >= limit) return limit
      }
    }
  }
  return Math.min(work, limit)
}

function textboxMountWork(boxes: readonly TextboxDisplay[], limit: number): number {
  let work = 0
  for (const box of boxes) {
    // Even a one-line editable box creates its own view and plugin state.
    work += box.readOnly ? 1 : 2 * ORDINARY_BLOCK_WORK
    if (work >= limit) return limit
    for (const para of box.paras) {
      work += runsMountWork(para.runs, limit - work)
      if (work >= limit) return limit
      for (const cell of para.cells ?? []) {
        if (++work >= limit) return limit
        for (const runs of cell.paras) {
          work += runsMountWork(runs, limit - work)
          if (work >= limit) return limit
        }
      }
    }
  }
  return work
}

function nodeMountWork(node: PmNode, limit: number): number {
  let work = 1 + (node.marks?.length ?? 0) + textMountWork(node.text)
  if (node.type === 'docTable' && Array.isArray(node.attrs?.colWidthsPct))
    work += node.attrs.colWidthsPct.length
  // These views build content from model attributes outside the node descendants.
  const table = (node.type === 'docNestedTable' ? node.attrs?.model : node.attrs?.table) as
    TableModel | undefined
  if (Array.isArray(table?.rows) && work < limit) work += nestedTableMountWork(table, limit - work)
  const boxes = node.type === 'docCellBoxes' ? node.attrs?.boxes : node.attrs?.textboxes
  if (Array.isArray(boxes) && work < limit)
    work += textboxMountWork(boxes as TextboxDisplay[], limit - work)
  for (const child of node.content ?? []) {
    if (work >= limit) break
    work += nodeMountWork(child, limit - work)
  }
  return Math.min(work, limit)
}

/** bumping the token cancels the pending tail (its chunks become no-ops) */
let token = 0
let settled = Promise.resolve(true)
let failed = false
/** clears the loading flag / resolves settled when a load is cancelled mid-stream */
let cancelPending: (() => void) | null = null
let unmountedSource: { owner: object; has: (index: number) => boolean } | null = null

/** Absence from the mounted editor does not imply deletion while loading. */
export function unmountedSourceBlocksOf(owner: object): ((index: number) => boolean) | undefined {
  return unmountedSource?.owner === owner ? unmountedSource.has : undefined
}

/** False if this stream failed or was replaced before all blocks landed. */
export function waitForFullContent(): Promise<boolean> {
  return settled
}

/** The current document may be truncated after a failed or abandoned mount. */
export function hasFailedPhasedContent(): boolean {
  return failed
}

/** true while a phased open still has tail chunks to append */
export function isPhasedContentPending(): boolean {
  return cancelPending !== null
}

function replaceStream(): number {
  const generation = ++token
  const cancel = cancelPending
  // The loading callback may start its own open. Drop the old owner first.
  unmountedSource = null
  cancelPending = null
  failed ||= cancel !== null
  settled = Promise.resolve(!failed)
  cancel?.()
  return generation
}

function completeReplacement(generation: number): void {
  if (generation !== token) return
  failed = false
  settled = Promise.resolve(true)
}

/** Cancel the tail. A successful full replacement also releases the output gate. */
export function cancelPhasedContent(replace?: () => void): void {
  const generation = replaceStream()
  if (!replace || generation !== token) return
  replace()
  completeReplacement(generation)
}

/**
 * Double-rAF: the browser paints the previous mount between the two callbacks.
 * A timer races the frames: a background tab (a hidden shell view keeps
 * document.hidden false but is handed about one frame a second) would
 * otherwise stretch a long open into hours, one chunk per second.
 */
export const PAINTED_FRAME_FALLBACK_MS = 80
const nextPaintedFrame = (cb: () => void): void => {
  let done = false
  let raf2 = 0
  const fire = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    cb()
  }
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fire)
  })
  const timer = setTimeout(fire, PAINTED_FRAME_FALLBACK_MS)
}

export function setContentPhased(
  host: PhasedContentHost,
  pmDoc: PmNode,
  schedule: (cb: () => void) => void = nextPaintedFrame,
  now: () => number = () => performance.now(),
): void {
  const my = replaceStream()
  if (my !== token) return
  const content = pmDoc.content ?? []
  const weights: number[] = []
  const batchFrom = (start: number, budget: number) => {
    let end = start
    let work = 0
    while (end < content.length) {
      const next = (weights[end] ??= Math.max(
        ORDINARY_BLOCK_WORK,
        nodeMountWork(content[end], SINGLE_MOUNT_WORK + 1),
      ))
      // Always make progress, but give an oversized block its own transaction.
      if (end > start && work + next > budget) break
      work += next
      end++
      if (work >= budget) break
    }
    return { end, work }
  }
  if (
    content.length <= 1 ||
    (content.length <= PHASED_MIN_BLOCKS &&
      batchFrom(0, SINGLE_MOUNT_WORK).end === content.length &&
      weights.every((work) => work <= MAX_APPEND_WORK))
  ) {
    host.setContent(pmDoc)
    completeReplacement(my)
    return
  }
  const firstEnd = batchFrom(0, PHASE1_BLOCKS * ORDINARY_BLOCK_WORK).end
  const remaining = new Map<number, number>()
  if (host.owner) {
    for (let i = firstEnd; i < content.length; i++) {
      const index = content[i].attrs?.docxIndex
      if (typeof index === 'number') remaining.set(index, (remaining.get(index) ?? 0) + 1)
    }
    unmountedSource = { owner: host.owner, has: (index) => remaining.has(index) }
  }
  // The first mount can throw after installing an incomplete prefix.
  failed = true
  settled = Promise.resolve(false)
  try {
    host.setContent({ ...pmDoc, content: content.slice(0, firstEnd) })
  } catch (error) {
    if (my === token) unmountedSource = null
    throw error
  }
  if (my !== token) return
  failed = false
  let settle!: (complete: boolean) => void
  settled = new Promise<boolean>((resolve) => (settle = resolve))
  const release = (complete: boolean) => {
    try {
      host.setLoading(false)
    } finally {
      settle(complete && my === token)
    }
  }
  cancelPending = () => release(false)
  host.setLoading(true)
  if (my !== token) return
  let index = firstEnd
  let budget = MAX_APPEND_WORK
  let previous: { finished: number; dispatchMs: number; work: number } | undefined
  const finish = (complete: boolean) => {
    if (my !== token) return
    // still "pending" through the history reset: it re-creates the plugin
    // views, whose constructors would otherwise measure the whole document
    // once before the settled event asks for the same pass again
    if (complete && !host.getDirty()) host.resetHistory()
    if (my !== token) return
    if (complete || host.isDestroyed()) unmountedSource = null
    failed = !complete && !host.isDestroyed()
    cancelPending = null
    release(complete)
    if (my !== token || typeof document === 'undefined') return
    if (complete) document.dispatchEvent(new Event(PHASED_CONTENT_SETTLED_EVENT))
    else if (failed && host.owner)
      document.dispatchEvent(new CustomEvent(PHASED_CONTENT_FAILED_EVENT, { detail: host.owner }))
  }
  const publish = (nodes: PmNode[]) => {
    const attempt = {}
    for (const node of nodes) {
      const source = node.attrs?.docxIndex
      if (typeof source !== 'number') continue
      const n = remaining.get(source) ?? 0
      if (n > 1) remaining.set(source, n - 1)
      else remaining.delete(source)
    }
    let failure: { error: unknown } | undefined
    try {
      host.appendNodes(nodes, attempt)
    } catch (error) {
      failure = { error }
    }
    if (my !== token || host.isDestroyed()) return
    const applied = host.appliedAppend(attempt)
    if (!applied) {
      for (const node of nodes) {
        const source = node.attrs?.docxIndex
        if (typeof source === 'number') remaining.set(source, (remaining.get(source) ?? 0) + 1)
      }
      failure ??= { error: new Error('The editor refused the streamed content') }
    }
    return { applied, failure }
  }
  const appendChunk = (finishInOnePass = false) => {
    if (my !== token) return
    if (host.isDestroyed()) return finish(false)
    if (previous) {
      // Layout and painting can happen after dispatch. Size the next append
      // against dispatch work and any delay beyond the intentional timer wait.
      const late = Math.max(0, now() - previous.finished - PAINTED_FRAME_FALLBACK_MS)
      const scale = PHASE_APPEND_BUDGET_MS / Math.max(0.1, previous.dispatchMs + late)
      budget = Math.min(
        MAX_APPEND_WORK,
        budget * 2,
        Math.max(ORDINARY_BLOCK_WORK, Math.floor(previous.work * scale)),
      )
    }
    const start = index
    const { end, work } = finishInOnePass
      ? { end: content.length, work: 0 }
      : batchFrom(start, budget)
    const started = now()
    const result = publish(content.slice(start, end))
    if (!result) return finish(false)
    if (result.failure) {
      // A dispatch can throw after installing its state. Append only the
      // missing source blocks to the current model, keeping foreground edits
      // and the held input's position mapping intact.
      const missing = result.applied ? end : start
      if (missing === content.length) return finish(true)
      const recovery = publish(content.slice(missing))
      if (recovery?.applied) return finish(true)
      finish(false)
      if (my === token && recovery?.failure) host.onFailure?.(recovery.failure.error)
      return
    }
    const finished = now()
    previous = { finished, dispatchMs: finished - started, work }
    index = end
    if (index < content.length) schedule(appendChunk)
    else finish(true)
  }
  if (host.canMountTail) {
    void host.canMountTail.then((mount) => {
      if (my !== token) return
      // The dedicated layout renderer has no input or visible frames to protect.
      // Once the owner has the source, settle the remaining layout in one mount.
      if (mount) schedule(() => appendChunk(true))
      else finish(false)
    })
  } else schedule(appendChunk)
}
