import { expect, it } from 'vitest'
import {
  planScrollbarDrag,
  summarizeViewportEvidence,
  verifyDragLanding,
} from '../../../e2e/docs-performance-viewport'

const scroll = {
  top: 400_000,
  clientHeight: 840,
  scrollHeight: 1_000_840,
  gutter: 15,
  bounds: { left: 0, right: 1200, top: 80, bottom: 920 },
}

it('builds in-track trajectories with distinct normal and fast reversing strokes', () => {
  const normal = planScrollbarDrag(scroll, 'normal-drag', 1)
  const fast = planScrollbarDrag(scroll, 'fast-drag', 1)
  expect(normal.x).toBe(1192.5)
  expect(normal.segments).toHaveLength(1)
  expect(fast.segments).toHaveLength(3)
  expect(fast.segments[0].y).toBeGreaterThan(fast.segments[1].y)
  expect(fast.segments[2].y).toBeGreaterThan(fast.segments[1].y)
  expect(normal.segments[0].pauseMs).toBeGreaterThan(fast.segments[0].pauseMs)
  expect(fast.finalTop).toBeGreaterThan(normal.finalTop)
  for (const { y } of fast.segments) {
    expect(y).toBeGreaterThan(scroll.bounds.top)
    expect(y).toBeLessThan(scroll.bounds.bottom)
  }
})

it('requires a physical scrollbar and verifies the predicted landing instead of just movement', () => {
  expect(() => planScrollbarDrag({ ...scroll, gutter: 0 }, 'normal-drag', 1)).toThrow(
    'classic vertical scrollbar',
  )
  const drag = planScrollbarDrag(scroll, 'normal-drag', 1)
  expect(() => verifyDragLanding(drag, scroll.top + 5, scroll)).toThrow('landing')
  expect(() => verifyDragLanding(drag, drag.finalTop, scroll)).not.toThrow()
  expect(() =>
    verifyDragLanding(drag, drag.finalTop, {
      ...scroll,
      scrollHeight: scroll.scrollHeight + 400,
    }),
  ).toThrow('geometry')
})

it('keeps drawing observations diagnostic even when all native gestures succeeded', () => {
  const accepted = summarizeViewportEvidence([
    { phase: 'progressive', action: 'normal-drag', observation: 'captured' },
    { phase: 'settled', action: 'fast-drag', observation: 'captured' },
    { phase: 'settled', action: 'go-to', observation: 'failed' },
  ])
  expect(accepted.status).toBe('incomplete')
  expect(accepted.reason).toContain('correct native-presented frames')
  expect(accepted.scenarios).toMatchObject({
    'progressive/normal-drag': { observations: 1, failures: 0, formalSamples: 0 },
    'settled/fast-drag': { observations: 1, failures: 0, formalSamples: 0 },
    'settled/go-to': { observations: 0, failures: 1, formalSamples: 0 },
  })
})
