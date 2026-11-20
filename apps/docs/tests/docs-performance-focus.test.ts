// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
const native = vi.hoisted(() => vi.fn())
vi.mock('../../../e2e/windows-native-ime', () => ({ runWindowsNativeIme: native }))
import { createPerformanceFocusGuard } from '../../../e2e/docs-performance-focus'

const owner = {
  targetProcessId: 1234,
  windowHandle: '55',
  processStartTime: '2026-11-19T00:00:00Z',
}
const snapshot = (focused = true) => ({ owner, foregroundOwned: focused, focusOwned: focused })
const page = () => ({
  bringToFront: vi.fn().mockResolvedValue(undefined),
  locator: () => ({ first: () => ({ focus: vi.fn().mockResolvedValue(undefined) }) }),
  evaluate: vi.fn().mockResolvedValue({ visibilityState: 'visible', hasFocus: true, losses: [] }),
})

it('uses native owned-window activation and verifies real foreground after CDP activation', async () => {
  native
    .mockReset()
    .mockResolvedValueOnce({ before: snapshot(false) })
    .mockResolvedValueOnce({ after: snapshot() })
    .mockResolvedValueOnce({ before: snapshot() })
  const guard = createPerformanceFocusGuard('qt', page() as unknown as Page, owner.targetProcessId)
  await guard.begin()
  expect(native.mock.calls.map(([request]) => request.action)).toEqual([
    'inspect',
    'focus',
    'inspect',
  ])
  expect(native.mock.calls[1][0]).toEqual({ action: 'focus', ...owner })
})

it('fails when native foreground remains absent even though CDP/DOM report focus', async () => {
  native
    .mockReset()
    .mockResolvedValueOnce({ before: snapshot(false) })
    .mockResolvedValueOnce({ after: snapshot() })
    .mockResolvedValueOnce({ before: snapshot(false) })
  const guard = createPerformanceFocusGuard(
    'electron',
    page() as unknown as Page,
    owner.targetProcessId,
  )
  await expect(guard.begin()).rejects.toThrow('Native foreground/focus is not owned')
})

it('rejects owner replacement before issuing another activation', async () => {
  native
    .mockReset()
    .mockResolvedValueOnce({ before: snapshot() })
    .mockResolvedValueOnce({ before: snapshot() })
    .mockResolvedValueOnce({ before: { ...snapshot(), owner: { ...owner, windowHandle: '99' } } })
  const guard = createPerformanceFocusGuard('qt', page() as unknown as Page, owner.targetProcessId)
  await guard.begin()
  await expect(guard.begin()).rejects.toThrow('Native measurement owner changed')
  expect(native.mock.calls.map(([request]) => request.action)).toEqual([
    'inspect',
    'inspect',
    'inspect',
  ])
})

it('invalidates an interval with transient DOM focus loss even if final native foreground is restored', async () => {
  native.mockReset().mockResolvedValue({ before: snapshot() })
  const actualPage = page()
  const guard = createPerformanceFocusGuard(
    'qt',
    actualPage as unknown as Page,
    owner.targetProcessId,
  )
  await guard.begin()
  actualPage.evaluate.mockResolvedValueOnce({
    visibilityState: 'visible',
    hasFocus: true,
    losses: [{ type: 'blur', at: 17 }],
  })
  await expect(guard.end()).rejects.toThrow(
    'Focus or visibility was lost during the measured interval',
  )
})

it('records headless browser OS foreground as not applicable without launching any native helper', async () => {
  native.mockReset()
  const guard = createPerformanceFocusGuard('browser', page() as unknown as Page)
  const before = await guard.begin()
  const after = await guard.end()
  expect(before.native).toBe('not-applicable-headless-browser')
  expect(after.native).toBe('not-applicable-headless-browser')
  expect(native).not.toHaveBeenCalled()
})

it('checks each sample inside one continuously observed phase without spawning per-sample native processes', async () => {
  native.mockReset().mockResolvedValue({ before: snapshot() })
  const guard = createPerformanceFocusGuard('qt', page() as unknown as Page, owner.targetProcessId)
  await guard.begin()
  for (let i = 0; i < 30; i++) await guard.check()
  await guard.end()
  expect(native).toHaveBeenCalledTimes(3)
})

it('samples native Electron focus before closing the observed phase', async () => {
  native.mockReset()
  const actualPage = page()
  let phaseEnded = false
  actualPage.evaluate.mockImplementation(async (_, mode) => {
    if (mode === 'end') phaseEnded = true
    return { visibilityState: 'visible', hasFocus: true, losses: [] }
  })
  const inspectNativeFocus = vi.fn().mockImplementation(async () => ({
    before: snapshot(!phaseEnded),
  }))
  const guard = createPerformanceFocusGuard(
    'electron',
    actualPage as unknown as Page,
    owner.targetProcessId,
    {
      inspectNativeFocus,
    },
  )
  await guard.begin()
  await guard.check()
  await guard.end()
  expect(phaseEnded).toBe(true)
  expect(inspectNativeFocus.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [owner.targetProcessId]),
  )
  expect(native).not.toHaveBeenCalled()
})

it('preserves actual blur evidence across lightweight checks until phase end', async () => {
  const actualPage = page()
  const fakeWindow = new EventTarget()
  const fakeDocument = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    hasFocus: () => true,
  })
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  actualPage.evaluate.mockImplementation(async (fn, arg) => fn(arg))
  try {
    const guard = createPerformanceFocusGuard('browser', actualPage as unknown as Page)
    await guard.begin()
    await guard.check()
    fakeWindow.dispatchEvent(new Event('blur'))
    await expect(guard.check()).rejects.toThrow('Focus or visibility was lost')
    await expect(guard.end()).rejects.toThrow('Focus or visibility was lost')
  } finally {
    vi.unstubAllGlobals()
  }
})
