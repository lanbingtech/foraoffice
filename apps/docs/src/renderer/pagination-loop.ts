/**
 * Loop control for the self-scheduled pagination passes.
 *
 * A pass that applies decorations (row fills, wrap widths, shrink spacing)
 * asks for one more pass to measure the DOM with them in place. A decision
 * that flips on every pass would ask forever; the writers that own their
 * layout (LibreOffice's layouter, OnlyOffice's recalc info) stop such a chain
 * by recognising the repeating cause, not by counting passes. This chain
 * refuses a request whose cause already repeated itself enough times and
 * reports the refusal, so the pass count stays a coarse backstop rather than
 * the normal exit. Two decisions undoing each other are caught by the same
 * budget: each side repeats.
 */

import type { Transaction } from '@tiptap/pm/state'

export const MAX_FOLLOW_UP_PASSES = 6
/** the same cause may legitimately re-fire a few times as layout settles */
const MAX_SAME_REASON = 3

export type FollowUpVerdict = 'run' | 'repeat' | 'cap'

/** During progressive open, only appends needed by the viewport extend the
 * published pages. The content-settled event requests the complete layout. */
export class StreamingPageCoverage {
  private published?: { mountedBlocks: number; paperEnd: number }

  publish(mountedBlocks: number, paperEnd: number): void {
    this.published = { mountedBlocks, paperEnd }
  }

  needsLayout(mountedBlocks: number, viewportBottom: number): boolean {
    return (
      !this.published ||
      (mountedBlocks > this.published.mountedBlocks && this.reachesUncovered(viewportBottom))
    )
  }

  reachesUncovered(viewportBottom: number): boolean {
    return !this.published || viewportBottom >= this.published.paperEnd
  }
}

/** Carry a measured prefix through an edit while retaining its trailing lookahead. */
export function mapStreamingPagePrefix(
  measuredBlocks: number,
  transaction: Transaction,
): number | undefined {
  const previous = transaction.before
  if (measuredBlocks < 3 || measuredBlocks > previous.childCount) return
  const lookahead = measuredBlocks - 2
  let end = 0
  for (let index = 0; index < measuredBlocks; index++) end += previous.child(index).nodeSize
  let guard = end - previous.child(lookahead).nodeSize - previous.child(lookahead + 1).nodeSize
  for (const [index, map] of transaction.mapping.maps.entries()) {
    const before = transaction.docs[index]
    const after = transaction.docs[index + 1] ?? transaction.doc
    if (!before) return
    let textEdit = false
    let unsafe = false
    map.forEach((from, to, newFrom, newTo) => {
      const start = before.resolve(from)
      const head = after.resolve(newFrom)
      const tail = after.resolve(newTo)
      if (
        to >= guard ||
        start.depth !== 1 ||
        !start.parent.isTextblock ||
        !start.sameParent(before.resolve(to)) ||
        head.depth !== 1 ||
        tail.depth !== 1 ||
        !head.parent.isTextblock ||
        !tail.parent.isTextblock ||
        tail.index(0) - head.index(0) > 1
      )
        unsafe = true
      else textEdit = true
    })
    // Empty maps can change attributes or marks at any source position.
    if (unsafe || !textEdit) return
    guard = map.map(guard)
    end = map.map(end, -1)
  }
  const current = transaction.doc
  const boundary = current.resolve(end)
  const count = boundary.index(0)
  if (
    boundary.depth !== 0 ||
    count < 3 ||
    current.child(count - 2) !== previous.child(lookahead) ||
    current.child(count - 1) !== previous.child(lookahead + 1)
  )
    return
  return count
}

export class FollowUpChain {
  /** reasons across the whole chain, in request order */
  readonly log: string[] = []
  /** follow-up passes this chain has run */
  passes = 0
  /** requests refused as a loop */
  stops = 0
  private counts = new Map<string, number>()
  /** causes already waiting for the next pass: re-asking is not a repeat */
  private pending = new Set<string>()
  /** causes refused for the rest of the chain */
  private refused = new Map<string, FollowUpVerdict>()

  /** a pass that was not self-scheduled starts a new chain */
  reset(): void {
    this.log.length = 0
    this.passes = 0
    this.stops = 0
    this.counts.clear()
    this.pending.clear()
    this.refused.clear()
  }

  /** a follow-up pass started: the causes it answers are no longer pending */
  beginPass(): void {
    this.passes++
    this.pending.clear()
  }

  request(reason: string, dirtyIndex: number | null): FollowUpVerdict {
    const key = dirtyIndex === null ? reason : `${reason}@${dirtyIndex}`
    const earlier = this.refused.get(key)
    if (earlier) {
      this.log.push(`${reason}!${earlier}`)
      return earlier
    }
    this.log.push(reason)
    if (this.pending.has(key)) return 'run'
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    let verdict: FollowUpVerdict = 'run'
    if (this.passes >= MAX_FOLLOW_UP_PASSES) verdict = 'cap'
    else if (n > MAX_SAME_REASON) verdict = 'repeat'
    if (verdict === 'run') this.pending.add(key)
    else {
      this.stops++
      this.refused.set(key, verdict)
      this.log[this.log.length - 1] = `${reason}!${verdict}`
    }
    return verdict
  }
}
