export const viewportActions = ['normal-drag', 'fast-drag', 'go-to'] as const
export type ViewportAction = (typeof viewportActions)[number]
export type ViewportPhase = 'progressive' | 'settled'

export type ScrollGeometry = {
  top: number
  clientHeight: number
  scrollHeight: number
  gutter: number
  bounds: { left: number; right: number; top: number; bottom: number }
}

export type ScrollStroke = {
  x: number
  y: number
  segments: Array<{ y: number; steps: number; pauseMs: number }>
  finalTop: number
  scrollRange: number
  pixelsPerThumbPixel: number
}

export function planScrollbarDrag(
  scroll: ScrollGeometry,
  action: Exclude<ViewportAction, 'go-to'>,
  direction: 1 | -1,
): ScrollStroke {
  const { top, clientHeight, scrollHeight, gutter, bounds } = scroll
  const scrollRange = scrollHeight - clientHeight
  // The Windows classic bar reserves one square at each end of the track.
  const track = clientHeight - 2 * gutter
  const travel = track - Math.max(18, (track * clientHeight) / scrollHeight)
  if (gutter < 8 || scrollRange <= clientHeight || travel < 96)
    throw new Error('A visible classic vertical scrollbar with usable thumb travel is required')
  const thumb = (travel * top) / scrollRange
  const y = bounds.top + gutter + (track - travel) / 2 + thumb
  const room = direction === 1 ? travel - thumb : thumb
  const distance = Math.min(action === 'normal-drag' ? 32 : 112, room - 3)
  if (distance < 20) throw new Error('Insufficient room to drag the native scrollbar')
  const offsets = action === 'normal-drag' ? [distance] : [distance, distance / 3, distance * 0.85]
  const segments = offsets.map((offset) => ({
    y: y + direction * offset,
    steps: action === 'normal-drag' ? 20 : 12,
    pauseMs: action === 'normal-drag' ? 24 : 6,
  }))
  const pixelsPerThumbPixel = scrollRange / travel
  return {
    x: bounds.right - gutter / 2,
    y,
    segments,
    scrollRange,
    pixelsPerThumbPixel,
    finalTop: top + direction * offsets.at(-1)! * pixelsPerThumbPixel,
  }
}

export function verifyDragLanding(
  stroke: ScrollStroke,
  actualTop: number,
  geometry: ScrollGeometry,
): void {
  if (geometry.scrollHeight - geometry.clientHeight !== stroke.scrollRange)
    throw new Error('Scrollbar geometry changed during the drag')
  // Native pointer positions are quantized to CSS/physical pixels.
  if (Math.abs(actualTop - stroke.finalTop) > 3 * stroke.pixelsPerThumbPixel)
    throw new Error(`Unexpected scrollbar landing, expected ${stroke.finalTop}, got ${actualTop}`)
}

export type ViewportObservation = {
  phase: ViewportPhase
  action: ViewportAction
  observation: 'captured' | 'failed' | 'unavailable'
}

/** DOM/rAF and screenshots retained by this harness do not timestamp OS presentation. */
export function summarizeViewportEvidence(records: readonly ViewportObservation[]) {
  return {
    status: 'incomplete' as const,
    reason: 'Timing and content correlation with correct native-presented frames is missing',
    scenarios: Object.fromEntries(
      (['progressive', 'settled'] as const).flatMap((phase) =>
        viewportActions.map((action) => {
          const matches = records.filter((item) => item.phase === phase && item.action === action)
          return [
            `${phase}/${action}`,
            {
              observations: matches.filter((item) => item.observation === 'captured').length,
              failures: matches.filter((item) => item.observation === 'failed').length,
              unavailable: matches.filter((item) => item.observation === 'unavailable').length,
              formalSamples: 0,
              required: 30,
            },
          ]
        }),
      ),
    ),
  }
}
