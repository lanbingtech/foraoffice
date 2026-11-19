import type { Page } from '@playwright/test'
import type { PerformanceHost } from './docs-performance-host'
import { runWindowsNativeIme, type NativeImeOwner } from './windows-native-ime'

type FocusState = {
  active: boolean
  losses: Array<{ type: string; at: number }>
}

/** Serialized into the actual host page; records transient loss rather than only final focus. */
function observeFocus(active: boolean) {
  const win = window as Window & { performanceFocus?: FocusState }
  let state = win.performanceFocus
  if (!state) {
    state = win.performanceFocus = { active: false, losses: [] }
    const record = (event: Event) => {
      if (state!.active) state!.losses.push({ type: event.type, at: performance.now() })
    }
    window.addEventListener('blur', record)
    document.addEventListener('visibilitychange', record)
  }
  if (active) state.losses = []
  state.active = active
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    losses: state.losses,
  }
}

export function createPerformanceFocusGuard(
  host: PerformanceHost,
  page: Page,
  nativeProcessId?: number,
) {
  let owner: NativeImeOwner | undefined
  const observations: Array<Record<string, unknown>> = []
  const inspect = async () => {
    if (host === 'browser') return 'not-applicable-headless-browser' as const
    if (!nativeProcessId) throw new Error('Native launcher-owned PID is missing')
    const evidence = await runWindowsNativeIme({
      action: 'inspect',
      targetProcessId: nativeProcessId,
    })
    const actual = evidence.before.owner
    if (
      owner &&
      (owner.windowHandle !== actual.windowHandle ||
        owner.processStartTime !== actual.processStartTime)
    )
      throw new Error('Native measurement owner changed')
    owner = actual
    return evidence
  }
  const requireNativeFocus = (evidence: Awaited<ReturnType<typeof inspect>>) => {
    if (
      typeof evidence !== 'string' &&
      (!evidence.before.foregroundOwned || !evidence.before.focusOwned)
    )
      throw new Error('Native foreground/focus is not owned')
  }
  const requireDomFocus = (state: ReturnType<typeof observeFocus>) => {
    if (state.visibilityState !== 'visible' || !state.hasFocus || state.losses.length)
      throw new Error('Focus or visibility was lost during the measured interval')
  }
  return {
    observations,
    async begin() {
      const before = await inspect()
      observations.push({ stage: 'before-activation', native: before })
      if (
        typeof before !== 'string' &&
        (!before.before.foregroundOwned || !before.before.focusOwned)
      )
        await runWindowsNativeIme({ action: 'focus', ...owner! })
      await page.bringToFront()
      await page.locator('.ProseMirror').first().focus()
      const native = await inspect()
      observations.push({ stage: 'after-native-verification', native })
      requireNativeFocus(native)
      const dom = await page.evaluate(observeFocus, true)
      observations.push({ stage: 'begin', native, dom })
      requireDomFocus(dom)
      return { native, dom }
    },
    async end() {
      const dom = await page.evaluate(observeFocus, false)
      const native = await inspect()
      observations.push({ stage: 'end', native, dom })
      requireNativeFocus(native)
      requireDomFocus(dom)
      return { native, dom }
    },
  }
}
