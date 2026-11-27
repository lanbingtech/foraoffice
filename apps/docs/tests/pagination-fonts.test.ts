// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { observePaginationFonts } from '../src/renderer/pagination-fonts'

it('cannot restart a disposed pagination effect when its older fonts.ready resolves', async () => {
  const events = new EventTarget()
  let ready!: (fonts: FontFaceSet) => void
  const fonts = {
    status: 'loading' as const,
    ready: new Promise<FontFaceSet>((resolve) => (ready = resolve)),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  }
  const oldEffect = vi.fn()
  const dispose = observePaginationFonts(fonts, oldEffect)
  dispose()
  const currentEffect = vi.fn()
  const disposeCurrent = observePaginationFonts(fonts, currentEffect)
  ready(fonts as FontFaceSet)
  await fonts.ready
  expect(oldEffect).not.toHaveBeenCalled()
  expect(currentEffect).toHaveBeenCalledWith(true)
  events.dispatchEvent(new Event('loadingdone'))
  expect(currentEffect).toHaveBeenCalledTimes(2)
  disposeCurrent()
})
