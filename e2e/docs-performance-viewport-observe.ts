import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import type { NativeImeOwner } from './windows-native-ime'
import type { Activity } from './docs-performance-layout-probe'
import {
  planScrollbarDrag,
  verifyDragLanding,
  type ScrollGeometry,
  type ViewportAction,
  type ViewportObservation,
  type ViewportPhase,
} from './docs-performance-viewport'

type Point = { x: number; y: number }
type NativeCommand =
  | { action: 'calibrate'; fraction: number }
  | {
      action: 'drag'
      x: number
      y: number
      segments: { y: number; steps: number; pauseMs: number }[]
    }
  | { action: 'submit' }
type NativeReceipt = {
  action: NativeCommand['action']
  position?: Point
  qpc?: string[]
  qpcFrequency: string
  utcBefore: string
  utcAfter: string
}

async function sendNativeInput(owner: NativeImeOwner, command: NativeCommand) {
  const request = Buffer.from(JSON.stringify({ owner, ...command })).toString('base64')
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(__dirname, 'docs-performance-native-scroll.ps1'),
      '-Request',
      request,
    ],
    // The helper bounds a held drag itself. Killing it could prevent button release.
    { windowsHide: true },
  )
  return JSON.parse(stdout) as NativeReceipt
}

/** Runs in the app and records DOM observations without retaining document text. */
function readViewport(mode: 'inspect' | 'start' | 'finish' | 'pointer' | 'calibrate') {
  type EventSample = {
    kind: string
    at: number
    top: number
    status: string | undefined
    trusted: boolean
    goToFieldValue?: number
  }
  type ViewportProbe = {
    pointers: Array<{ x: number; y: number; utcMs: number }>
    calibrating: boolean
    events: EventSample[]
    recording: boolean
  }
  const win = window as Window & {
    __docsLayoutActivity?: { snapshot(): Activity }
    __aidocs?: { editor: Editor; documentGeneration?(): number }
    docsPerformanceViewport?: ViewportProbe
  }
  const scroller = document.querySelector<HTMLElement>('.editor-scroll')
  const status = () => document.querySelector('.status-page')?.textContent?.trim()
  if (!win.docsPerformanceViewport) {
    const probe = (win.docsPerformanceViewport = {
      events: [],
      recording: false,
      pointers: [],
      calibrating: false,
    } as ViewportProbe)
    document.addEventListener(
      'pointermove',
      (event) => {
        if (probe.calibrating && event.isTrusted && probe.pointers.length < 30)
          probe.pointers.push({
            x: event.clientX,
            y: event.clientY,
            utcMs: performance.timeOrigin + event.timeStamp,
          })
      },
      true,
    )
    const record = (event: Event) => {
      if (!probe.recording || probe.events.length >= 300) return
      const activeScroller = document.querySelector<HTMLElement>('.editor-scroll')
      if (!activeScroller) return
      if (event.type === 'scroll' && event.target !== activeScroller) return
      if (event instanceof KeyboardEvent && event.key !== 'Enter') return
      const target = event.target
      const goToFieldValue =
        target instanceof HTMLInputElement &&
        target.matches('.find-panel input.find-goto-input') &&
        target === document.activeElement &&
        /^\d+$/.test(target.value)
          ? Number(target.value)
          : undefined
      probe.events.push({
        kind: event.type,
        at: performance.now(),
        top: activeScroller.scrollTop,
        status: status(),
        trusted: event.isTrusted,
        goToFieldValue,
      })
    }
    document.addEventListener('scroll', record, true)
    document.addEventListener('keydown', record, true)
  }
  const probe = win.docsPerformanceViewport
  if (mode === 'calibrate') {
    probe.pointers = []
    probe.calibrating = true
    return { ratio: devicePixelRatio }
  }
  if (mode === 'pointer') {
    probe.calibrating = false
    return { pointers: probe.pointers, ratio: devicePixelRatio }
  }
  if (mode === 'start') {
    probe.events = []
    probe.recording = true
  } else if (mode === 'finish') probe.recording = false
  const activity = win.__docsLayoutActivity?.snapshot()
  if (!scroller || !activity) return { activity }
  const { left, right, top, bottom } = scroller.getBoundingClientRect()
  const clientHeight = scroller.clientHeight
  const geometry = {
    top: scroller.scrollTop,
    clientHeight,
    scrollHeight: scroller.scrollHeight,
    gutter: scroller.offsetWidth - scroller.clientWidth,
    bounds: { left, right, top, bottom },
  } satisfies ScrollGeometry
  const anchors = new Set<string>()
  for (const x of [0.35, 0.5, 0.65]) {
    for (const y of [0.15, 0.35, 0.55, 0.75, 0.9]) {
      const hit = document.elementFromPoint(left + (right - left) * x, top + clientHeight * y)
      const source = hit?.closest<HTMLElement>('.ProseMirror.doc-page [data-idx]')
      if (source?.dataset.idx) anchors.add(source.dataset.idx)
    }
  }
  const editor = win.__aidocs?.editor
  const editable = !!editor?.isEditable && !!editor.view.dom.isContentEditable
  const caret = editor?.state.selection.from
  const renderedCaret =
    mode === 'finish' && caret !== undefined && editable
      ? editor!.view.coordsAtPos(caret)
      : undefined
  const pageStatus = status()
  const pageNumbers = pageStatus?.match(/\d+/g)?.map(Number)
  return {
    activity,
    documentGeneration: win.__aidocs?.documentGeneration?.(),
    geometry,
    ratio: devicePixelRatio,
    pageStatus,
    currentPage: pageNumbers?.[0],
    totalPages: pageNumbers?.[1],
    anchors: [...anchors],
    editable,
    editorHasFocus: editor?.view.hasFocus(),
    goToFieldFocused: document.activeElement?.matches('.find-panel input.find-goto-input'),
    caret,
    caretInViewport: !!renderedCaret && renderedCaret.top >= top && renderedCaret.bottom <= bottom,
    timeOriginMs: performance.timeOrigin,
    observedAtMs: performance.now(),
    events: mode === 'finish' ? probe.events : undefined,
  }
}

type ViewportState = ReturnType<typeof readViewport>

export async function calibrateNativeViewport(page: Page, owner: NativeImeOwner) {
  const points: Point[] = []
  for (const fraction of [0.37, 0.63]) {
    await page.evaluate(readViewport, 'calibrate' as const)
    let receipt: NativeReceipt
    let latest: ViewportState
    try {
      receipt = await sendNativeInput(owner, { action: 'calibrate', fraction })
    } finally {
      latest = await page.evaluate(readViewport, 'pointer' as const)
    }
    const started = Date.parse(receipt.utcBefore)
    const samples = latest.pointers?.filter(
      (sample) => sample.utcMs >= started && sample.utcMs <= Date.parse(receipt.utcAfter),
    )
    const pointer = samples?.[0]
    if (!pointer || samples!.length > 2 || !latest.ratio || !receipt.position)
      throw new Error('Windows client-to-viewport calibration is unavailable')
    points.push({
      x: receipt.position.x - pointer.x * latest.ratio,
      y: receipt.position.y - pointer.y * latest.ratio,
    })
  }
  if (Math.abs(points[0].x - points[1].x) > 2 || Math.abs(points[0].y - points[1].y) > 2)
    throw new Error('Windows client-to-viewport calibration is inconsistent')
  return points[1]
}

function activeLayout(state: ViewportState) {
  const activity = state.activity
  return !!activity && (activity.contentPending || activity.pending > 0 || activity.active > 0)
}

export type RecordedViewportObservation = ViewportObservation & {
  input: 'windows-native' | 'playwright-diagnostic'
  reason?: string
  before?: ViewportState
  after?: ViewportState
  actionPlan?: unknown
  receipt?: NativeReceipt
  closeReceipt?: NativeReceipt
  screenshot?: string
}

export async function observeViewport({
  page,
  phase,
  action,
  owner,
  origin,
  previousGeneration,
  screenshot,
}: {
  page: Page
  phase: ViewportPhase
  action: ViewportAction
  owner?: NativeImeOwner
  origin?: Point
  previousGeneration?: number
  screenshot: string
}): Promise<RecordedViewportObservation> {
  const record: RecordedViewportObservation = {
    phase,
    action,
    input: owner ? 'windows-native' : 'playwright-diagnostic',
    observation: 'unavailable',
  }
  const input = page.locator('.find-panel input.find-goto-input')
  const dismissGoTo = async () => {
    const close = page.locator('.find-panel .find-close')
    const ratio = record.before?.ratio
    if (!owner) {
      await close.click({ timeout: 3000 })
      return
    }
    if (!origin || !ratio) throw new Error('Windows client-to-viewport calibration is missing')
    const bounds = await close.boundingBox({ timeout: 3000 })
    if (!bounds) throw new Error('The Go To close button has no screen coordinates')
    const x = Math.round(origin.x + (bounds.x + bounds.width / 2) * ratio)
    const y = Math.round(origin.y + (bounds.y + bounds.height / 2) * ratio)
    // A stationary leg sends a native press and release at the close button.
    record.closeReceipt = await sendNativeInput(owner, {
      action: 'drag',
      x,
      y,
      segments: [{ y, steps: 1, pauseMs: 1 }],
    })
    await close.waitFor({ state: 'detached', timeout: 3000 })
  }
  let panelOpened = false
  let armed = false
  const inPhase = (state: ViewportState) =>
    phase === 'settled'
      ? !!state.activity &&
        state.activity.owners > 0 &&
        !state.activity.fontProbes &&
        !state.activity.errors.length &&
        !activeLayout(state)
      : !!state.activity &&
        state.activity.generation > (previousGeneration ?? -1) &&
        activeLayout(state)
  try {
    if (!owner && action !== 'go-to')
      throw new Error('A native scrollbar input channel is unavailable')
    const initial = await page.evaluate(readViewport, 'inspect' as const)
    record.before = initial
    if (!inPhase(initial) || !initial.geometry || !initial.editable)
      throw new Error('The requested phase has no compatible interactive viewport')
    // Layout effects can be replaced by font and pagination updates within one
    // open document. Use its identity across the action when the host exposes it.
    const sameDocument = (state: ViewportState) =>
      initial.documentGeneration === undefined
        ? state.activity?.generation === initial.activity?.generation
        : state.documentGeneration === initial.documentGeneration
    const arm = async () => {
      const state = await page.evaluate(readViewport, 'start' as const)
      record.before = state
      armed = true
      if (!inPhase(state) || !state.geometry || !sameDocument(state))
        throw new Error('Requested phase ended before the input')
      if (
        phase === 'settled' &&
        (state.geometry.top > 1 || state.currentPage !== 1 || !state.anchors?.length)
      )
        throw new Error(
          `The settled interaction did not start at the document top: ${state.pageStatus}, scroll ${state.geometry.top}`,
        )
      return state
    }
    if (action === 'go-to') {
      const { totalPages, currentPage } = initial
      if (!totalPages || !currentPage || totalPages < 6)
        throw new Error('No remote page is available')
      const target =
        currentPage > totalPages / 2 ? Math.ceil(totalPages * 0.2) : Math.floor(totalPages * 0.8)
      record.actionPlan = { target }
      await page.locator('.status-page').click({ timeout: 3000 })
      panelOpened = true
      await page.locator('.find-panel .find-select').first().selectOption('page', { timeout: 3000 })
      await input.fill(String(target), { timeout: 3000 })
      const before = await arm()
      if (!before.goToFieldFocused) throw new Error('Go To field does not own keyboard focus')
      if (owner) record.receipt = await sendNativeInput(owner, { action: 'submit' })
      else await input.press('Enter', { timeout: 3000 })
      const received = await page.waitForFunction(
        (requested) => {
          const probe = (
            window as Window & {
              docsPerformanceViewport?: {
                events: Array<{ kind: string; trusted: boolean; goToFieldValue?: number }>
              }
            }
          ).docsPerformanceViewport
          return probe?.events.some(
            (event) =>
              event.kind === 'keydown' && event.trusted && event.goToFieldValue === requested,
          )
        },
        target,
        { polling: 30, timeout: 3000 },
      )
      await received.dispose()
      record.observation = 'failed'
      const result = await page.waitForFunction(
        ({ target, caret }) => {
          const current = Number(
            document.querySelector('.status-page')?.textContent?.match(/\d+/)?.[0],
          )
          const model = (window as Window & { __aidocs?: { editor: Editor } }).__aidocs?.editor
          return current === target && model?.state.selection.from !== caret
        },
        { target, caret: before.caret },
        { polling: 50, timeout: 5000 },
      )
      await result.dispose()
    } else {
      const before = await arm()
      const geometry = before.geometry!
      const direction = geometry.top > (geometry.scrollHeight - geometry.clientHeight) / 2 ? -1 : 1
      const stroke = planScrollbarDrag(geometry, action, direction)
      record.actionPlan = stroke
      const ratio = before.ratio
      if (!owner || !origin || !ratio)
        throw new Error('Windows client-to-viewport calibration is missing')
      record.receipt = await sendNativeInput(owner, {
        action: 'drag',
        x: Math.round(origin.x + stroke.x * ratio),
        y: Math.round(origin.y + stroke.y * ratio),
        segments: stroke.segments.map((segment) => ({
          ...segment,
          y: Math.round(origin.y + segment.y * ratio),
        })),
      })
      record.observation = 'failed'
      const result = await page.waitForFunction(
        ({ stableTop, tolerance }) => {
          const top = document.querySelector('.editor-scroll')?.scrollTop
          return top !== undefined && Math.abs(top - stableTop) <= tolerance
        },
        { stableTop: stroke.finalTop, tolerance: stroke.pixelsPerThumbPixel * 3 },
        { polling: 50, timeout: 5000 },
      )
      await result.dispose()
      record.after = await page.evaluate(readViewport, 'finish' as const)
      armed = false
      if (!record.after.geometry) throw new Error('Scrollbar geometry disappeared')
      verifyDragLanding(stroke, record.after.geometry.top, record.after.geometry)
      if (action === 'fast-drag') {
        let previous = geometry.top
        let forward = false
        let reversal = false
        for (const event of record.after.events ?? []) {
          if (event.kind !== 'scroll') continue
          if (direction * (event.top - previous) > 0) forward = true
          if (forward && direction * (event.top - previous) < 0) reversal = true
          previous = event.top
        }
        if (!reversal) throw new Error('DOM observations missed the drag reversal')
      }
    }
    if (armed) {
      record.after = await page.evaluate(readViewport, 'finish' as const)
      armed = false
    }
    const after = record.after!
    if (!inPhase(after) || !sameDocument(after)) {
      record.observation = 'unavailable'
      throw new Error('The requested document phase did not span the observed interaction')
    }
    if (!after.anchors?.length || !after.editable)
      throw new Error('Observed viewport has no editable source anchors')
    if (action === 'go-to' && !after.caretInViewport)
      throw new Error('Go To did not expose an on-screen model caret')
    await page.screenshot({ path: screenshot, type: 'jpeg', quality: 65, timeout: 8000 })
    record.screenshot = screenshot
    record.observation = 'captured'
  } catch (error) {
    record.reason = String(error)
  } finally {
    try {
      if (armed) record.after = await page.evaluate(readViewport, 'finish' as const)
    } catch (error) {
      record.reason = [record.reason, String(error)].filter(Boolean).join('\n')
    }
    if (panelOpened) {
      try {
        await dismissGoTo()
      } catch (error) {
        record.reason = [record.reason, String(error)].filter(Boolean).join('\n')
        if (record.observation === 'captured') record.observation = 'failed'
      }
    }
  }
  return record
}
