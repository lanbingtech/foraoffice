import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import {
  FollowUpChain,
  MAX_FOLLOW_UP_PASSES,
  mapStreamingPagePrefix,
  StreamingPageCoverage,
} from '../src/renderer/pagination-loop'

describe('streamed page coverage', () => {
  it('only extends already laid pages when the viewport needs the appended content', () => {
    const coverage = new StreamingPageCoverage()
    expect(coverage.needsLayout(64, 0)).toBe(true)
    coverage.publish(64, 900)
    expect(coverage.needsLayout(128, 0)).toBe(false)
    expect(coverage.needsLayout(128, 899)).toBe(false)
    expect(coverage.needsLayout(128, 900)).toBe(true)
    expect(coverage.needsLayout(64, 900)).toBe(false)
    expect(coverage.reachesUncovered(899)).toBe(false)
    expect(coverage.reachesUncovered(900)).toBe(true)
    coverage.publish(128, 2500)
    expect(coverage.needsLayout(256, 910)).toBe(false)
  })
})

describe('measured page prefixes during progressive edits', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
    marks: { bold: {} },
  })
  const initial = () =>
    EditorState.create({
      doc: schema.node(
        'doc',
        null,
        ['first', 'second', 'guard one', 'guard two', 'unmeasured'].map((word) =>
          schema.node('paragraph', null, schema.text(word)),
        ),
      ),
    })

  it('moves the measured frontier through a paragraph split and subsequent typing', () => {
    const state = initial()
    const split = state.tr.split(3)
    const type = state.apply(split).tr.insertText('x', 6)
    expect(mapStreamingPagePrefix(4, split)).toBe(5)
    expect(mapStreamingPagePrefix(5, type)).toBe(5)
  })

  it('requires a new range when a change reaches the lookahead or unmounted tail', () => {
    const state = initial()
    const guard = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize
    const tail = guard + state.doc.child(2).nodeSize + state.doc.child(3).nodeSize
    expect(mapStreamingPagePrefix(4, state.tr.insertText('x', guard + 1))).toBeUndefined()
    expect(mapStreamingPagePrefix(4, state.tr.insertText('x', tail + 1))).toBeUndefined()
    expect(mapStreamingPagePrefix(4, state.tr.delete(2, guard + 1))).toBeUndefined()
  })

  it('does not carry geometry across unmapped changes or paragraph joins', () => {
    const state = initial()
    expect(
      mapStreamingPagePrefix(4, state.tr.addMark(1, 2, schema.marks.bold.create())),
    ).toBeUndefined()
    expect(mapStreamingPagePrefix(4, state.tr.join(state.doc.child(0).nodeSize))).toBeUndefined()
  })
})

describe('FollowUpChain', () => {
  it('runs distinct reasons and a reason that re-fires a few times', () => {
    const c = new FollowUpChain()
    expect(c.request('width', null)).toBe('run')
    expect(c.request('rowFills', null)).toBe('run')
    expect(c.request('width', null)).toBe('run')
    expect(c.request('width', null)).toBe('run')
    expect(c.stops).toBe(0)
  })

  it('refuses a reason past its repeat budget and marks the log', () => {
    const c = new FollowUpChain()
    for (let i = 0; i < 3; i++) {
      expect(c.request('rowFills', null)).toBe('run')
      c.beginPass()
    }
    expect(c.request('rowFills', null)).toBe('repeat')
    expect(c.stops).toBe(1)
    expect(c.log.at(-1)).toBe('rowFills!repeat')
  })

  it('keys a shrink request on its paragraph', () => {
    const c = new FollowUpChain()
    for (let i = 0; i < 3; i++) {
      expect(c.request('justify-shrink', 10)).toBe('run')
      c.beginPass()
    }
    expect(c.request('justify-shrink', 11)).toBe('run')
    expect(c.request('justify-shrink', 10)).toBe('repeat')
  })

  it('re-asking before the pass runs is one request', () => {
    const c = new FollowUpChain()
    for (let i = 0; i < 10; i++) expect(c.request('justify-shrink', 0)).toBe('run')
    c.beginPass()
    expect(c.request('justify-shrink', 0)).toBe('run')
    expect(c.stops).toBe(0)
  })

  it('two decisions undoing each other exhaust their budgets', () => {
    const c = new FollowUpChain()
    const verdicts: string[] = []
    for (let i = 0; i < 8; i++) {
      verdicts.push(c.request(i % 2 ? 'b' : 'a', null))
      c.beginPass()
    }
    expect(verdicts).toEqual(['run', 'run', 'run', 'run', 'run', 'run', 'cap', 'cap'])
  })

  it('a refused cause stays refused even when asked again', () => {
    const c = new FollowUpChain()
    for (let i = 0; i < 3; i++) {
      c.request('rowFills', null)
      c.beginPass()
    }
    expect(c.request('rowFills', null)).toBe('repeat')
    expect(c.request('rowFills', null)).toBe('repeat')
    expect(c.stops).toBe(1)
    expect(c.log.slice(-2)).toEqual(['rowFills!repeat', 'rowFills!repeat'])
  })

  it('a refused cause does not unblock through the pending set', () => {
    const c = new FollowUpChain()
    c.passes = MAX_FOLLOW_UP_PASSES
    expect(c.request('x', 0)).toBe('cap')
    expect(c.request('x', 0)).toBe('cap')
  })

  it('caps the pass count as a backstop', () => {
    const c = new FollowUpChain()
    c.passes = MAX_FOLLOW_UP_PASSES
    expect(c.request('fresh', null)).toBe('cap')
  })

  it('reset starts a new chain', () => {
    const c = new FollowUpChain()
    for (let i = 0; i < 4; i++) {
      c.request('x', null)
      c.beginPass()
    }
    c.reset()
    expect(c.request('x', null)).toBe('run')
    expect(c.log).toEqual(['x'])
    expect(c.stops).toBe(0)
  })
})
