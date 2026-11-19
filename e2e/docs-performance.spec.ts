import { readLayoutProbe, type Activity } from './docs-performance-layout-probe'
import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, realpath, readdir } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { buildPerformanceFixture, documentOracle } from './docs-performance-fixture'
import { collectPlatformFonts } from './docs-performance-fonts'
import { captureFailureEvidence } from './docs-performance-evidence'
import {
  mainStoryOracle,
  expectedTextboxStories,
  verifyTextboxStories,
} from './docs-performance-stories'
import type { createDocumentStoryDiagnostic } from '../apps/docs/src/renderer/document-story-diagnostic'
import { createPerformanceFocusGuard } from './docs-performance-focus'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'
import {
  documentZoom,
  expectedInsertion,
  verifySavedContent,
  verifyPrintedContent,
} from './docs-performance-oracle'
import {
  launchPerformanceHost,
  type PerformanceHost,
  type PerformanceSession,
} from './docs-performance-host'
import {
  assertExternalArtifacts,
  comparePerformanceReports,
  summarizeScenario,
  withDeadline,
  type PerformanceObservation,
} from './docs-performance-result'

type ProbeWindow = Window & {
  __docsLayoutActivity?: { snapshot(): Activity }
  __pageDebug?: {
    slices?: unknown[]
    sourceStories?: ReturnType<typeof createDocumentStoryDiagnostic>['snapshot']
  }
  performanceReady?: boolean
  docsEditor?: unknown
  performanceProbe?: {
    started: number
    activity: boolean
    input: Array<{ type: string; at: number; twoFrameCallbacksMs?: number }>
    longTasks: Array<{ start: number; duration: number }>
    frames: Array<{ at: number; gap: number }>
  }
}

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const now = () => Number(process.hrtime.bigint()) / 1_000_000
const repository = resolve(__dirname, '..')

async function installProbe(page: Page) {
  await page.evaluate(() => {
    const win = window as ProbeWindow
    if (win.performanceProbe) return
    win.performanceProbe = {
      started: performance.now(),
      activity: false,
      input: [],
      longTasks: [],
      frames: [],
    }
    const probe = win.performanceProbe
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    const frame = (at: number) => {
      if (probe.activity) probe.frames.push({ at, gap: at - last })
      last = at
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    const input = (event: Event) => {
      const type =
        event.type === 'keydown'
          ? 'Enter keydown'
          : event.type === 'beforeinput'
            ? (event as InputEvent).inputType
            : event.type
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return
      const item: { type: string; at: number; twoFrameCallbacksMs?: number } = {
        type,
        at: performance.now(),
      }
      probe.input.push(item)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          item.twoFrameCallbacksMs = performance.now() - item.at
        }),
      )
    }
    document.addEventListener('beforeinput', input, true)
    document.addEventListener('keydown', input, true)
    document.addEventListener('compositionstart', input, true)
    document.addEventListener('compositionupdate', input, true)
    document.addEventListener('compositionend', input, true)
  })
}

async function waitForLayout(
  page: Page,
  tail: string,
  timeout = 180_000,
  newerThan = -1,
  measurementStart = now(),
  textRuns: string[] = [],
) {
  const deadline = Date.now() + timeout
  const milestonesMs: Record<string, number> = {}
  let lastProbe: unknown
  let previous = ''
  let unchangedSince = 0
  while (Date.now() < deadline) {
    const state = await withDeadline(
      page.evaluate(readLayoutProbe, { end: tail, textRuns }),
      Math.max(1, deadline - Date.now()),
      'layout probe',
    )
    if (state.activity?.errors.length)
      throw new Error(`Pagination failed: ${state.activity.errors.join('; ')}`)
    const a = state.activity
    const idle =
      !!a &&
      a.version === 1 &&
      a.generation > newerThan &&
      a.owners > 0 &&
      !a.contentPending &&
      a.pending === 0 &&
      a.active === 0 &&
      a.fontProbes === 0
    lastProbe = { ...state, diagnosticIdle: idle }
    if (a && a.generation > newerThan) {
      if (state.complete && !a.contentPending)
        milestonesMs['complete-content-observed'] ??= now() - measurementStart
      if (state.complete && state.imagesReady)
        milestonesMs['complete-media-observed'] ??= now() - measurementStart
      if (state.fonts?.status === 'loaded' && state.fonts.count > 0)
        milestonesMs['fonts-loaded-observed'] ??= now() - measurementStart
      if (idle) milestonesMs['no-pending-layout-observed'] ??= now() - measurementStart
    }
    const valid =
      idle &&
      state.complete &&
      state.visible &&
      state.imagesReady &&
      state.fonts?.status === 'loaded' &&
      state.fonts.count > 0 &&
      (state.pages ?? 0) > 0
    if (valid && state.signature === previous) {
      if (Date.now() - unchangedSince >= 250) {
        state.environment.zoom = await page.locator('.ProseMirror').first().evaluate(documentZoom)
        return { ...state, milestonesMs }
      }
    } else {
      previous = state.signature
      unchangedSince = Date.now()
    }
    await page.waitForTimeout(50)
  }
  throw Object.assign(
    new Error('Document completeness, pending layout, fonts/images and geometry did not settle'),
    { lastProbe },
  )
}

async function firstDiagnosticIdle(page: Page, started: number, newerThan = -1) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const activity = await withDeadline(
      page.evaluate(() => (window as ProbeWindow).__docsLayoutActivity?.snapshot()),
      Math.max(1, deadline - Date.now()),
      'pending-work observation',
    )
    if (!activity || activity.version !== 1)
      throw new Error('Current layout activity diagnostics are missing')
    if (activity.errors.length) throw new Error(activity.errors.join('; '))
    if (
      activity.generation > newerThan &&
      activity.owners > 0 &&
      !activity.contentPending &&
      activity.pending === 0 &&
      activity.active === 0 &&
      activity.fontProbes === 0
    )
      return now() - started
    await page.waitForTimeout(25)
  }
  throw new Error('Pending layout work did not become idle')
}

async function firstVisibleContent(page: Page, head: string, newerThan: number) {
  await page.waitForFunction(
    ({ head, newerThan }) => {
      const pm = document.querySelector<HTMLElement>('.ProseMirror')
      const activity = (window as ProbeWindow).__docsLayoutActivity?.snapshot()
      if (
        !pm ||
        !pm.textContent?.replace(/\s+/g, '').includes(head) ||
        !activity ||
        activity.generation <= newerThan
      )
        return false
      const rect = pm.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    },
    { head, newerThan },
    { timeout: 180_000, polling: 50 },
  )
  const started = now()
  const image = await page.screenshot({ type: 'jpeg', quality: 60 })
  return { image, screenshotMs: now() - started }
}

async function verifyRenderedStories(page: Page, documentXml: string, artifact: string) {
  const state = await withDeadline(
    page.evaluate(() => {
      const win = window as ProbeWindow
      const sources = win.__pageDebug?.sourceStories?.()
      const activity = win.__docsLayoutActivity?.snapshot()
      const pm = document.querySelector('.editor-scroll .ProseMirror')
      const boxes = [...(pm?.querySelectorAll<HTMLElement>('.doc-textbox') ?? [])]
        .filter((box) => !box.closest('.page-gap,.page-repeat-header'))
        .map((box) => {
          const owner = box.closest<HTMLElement>('[data-idx]')?.dataset.idx
          const ordinal = box.dataset.sourceTxbxIndex
          const rect = box.getBoundingClientRect()
          const style = getComputedStyle(box)
          return {
            docxIndex: owner !== undefined && /^\d+$/.test(owner) ? Number(owner) : null,
            txbxIndex: ordinal !== undefined && /^\d+$/.test(ordinal) ? Number(ordinal) : undefined,
            shapeId: box.dataset.sourceShapeId,
            text: box.textContent ?? '',
            laidOut:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          }
        })
      return { sources, activity, boxes }
    }),
    30_000,
    'source-bound textbox fidelity',
  )
  // Raw source/story evidence belongs only to the configured external fidelity artifacts.
  await writeFile(artifact, JSON.stringify(state, null, 2))
  const sources = state.sources
  if (
    !sources ||
    sources.version !== 1 ||
    sources.disposed ||
    !Number.isInteger(sources.documentGeneration) ||
    sources.layoutGeneration !== state.activity?.generation
  )
    throw new Error(
      'Current source-story diagnostics are missing, disposed or generation-mismatched',
    )
  const expected = expectedTextboxStories(
    documentXml,
    sources.blocks.filter((block) => block.textboxes.length > 0),
  )
  verifyTextboxStories(expected, state.boxes)
  return {
    documentGeneration: sources.documentGeneration,
    layoutGeneration: sources.layoutGeneration,
    textStories: expected.length,
    renderedTextStories: state.boxes.filter((box) => box.text.trim()).length,
  }
}

async function chooseText(page: Page, kind: 'paragraph' | 'table', fraction: number) {
  return page.evaluate(
    ({ kind, fraction }) => {
      const pm = document.querySelector<HTMLElement>('.ProseMirror')
      if (!pm?.isContentEditable) throw new Error('Current document is not editable')
      const candidates = [
        ...pm.querySelectorAll<HTMLElement>(kind === 'table' ? 'td p, th p' : ':scope > p'),
      ].filter(
        (p) => (p.textContent?.trim().length ?? 0) >= 12 && !p.closest('[contenteditable="false"]'),
      )
      const target =
        candidates[Math.min(candidates.length - 1, Math.floor(candidates.length * fraction))]
      if (!target) throw new Error(`No editable ${kind} text candidate`)
      target.scrollIntoView({ block: 'center' })
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      if (!node?.textContent) throw new Error('Selected paragraph has no text')
      const range = document.createRange()
      range.setStart(node, Math.min(2, node.textContent.length))
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      pm.focus()
      return {
        text: pm.textContent ?? '',
        paragraphs: pm.querySelectorAll(':scope > p').length,
        targetText: target.textContent ?? '',
        insertOffset: node.textContent
          .slice(0, Math.min(2, node.textContent.length))
          .replace(/\s+/g, '').length,
      }
    },
    { kind, fraction },
  )
}

async function waitForPdf(file: string) {
  await expect
    .poll(
      async () => {
        try {
          return (await PDFDocument.load(await readFile(file))).getPageCount()
        } catch {
          return 0
        }
      },
      { timeout: 180_000 },
    )
    .toBeGreaterThan(0)
  return PDFDocument.load(await readFile(file))
}

async function treeDigest(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  const hashes: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
    hashes.push(
      `${entry.name}:${entry.isDirectory() ? await treeDigest(join(root, entry.name)) : sha(await readFile(join(root, entry.name)))}`,
    )
  return sha(hashes.join('\n'))
}

test('production document performance and correctness evidence', async () => {
  test.skip(
    !process.env.FORAOFFICE_PERF_HOST,
    'Opt-in performance run; use docs-performance.config.ts',
  )
  const host = process.env.FORAOFFICE_PERF_HOST as PerformanceHost
  const label = process.env.FORAOFFICE_PERF_LABEL!
  const artifactRoot = await realpath(process.env.FORAOFFICE_PERF_ARTIFACTS!)
  assertExternalArtifacts(await realpath(repository), artifactRoot)
  const root = await mkdtemp(
    join(artifactRoot, `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${host}-`),
  )
  const sdk = resolve(
    process.env.FORAOFFICE_DOCS_PACKAGE_ROOT ?? join(repository, 'apps/docs/out/sdk'),
  )
  const build = JSON.parse(await readFile(join(sdk, 'build-info.json'), 'utf8'))
  const bytes = process.env.FORAOFFICE_PERF_DOCX
    ? await readFile(process.env.FORAOFFICE_PERF_DOCX)
    : await buildPerformanceFixture(Number(process.env.FORAOFFICE_PERF_SCALE ?? 1))
  const oracle = await documentOracle(bytes)
  const sourceXml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
  const mainStory = mainStoryOracle(sourceXml)
  const primerText = 'Performance runtime primer'
  const primer = await buildDocx({ bodyXml: `<w:p><w:r><w:t>${primerText}</w:t></w:r></w:p>` })
  const tail = oracle.tail
  const samples = process.env.FORAOFFICE_PERF_SMOKE === '1' ? 1 : 30
  const opens = process.env.FORAOFFICE_PERF_SMOKE === '1' ? 1 : 10
  const launches = process.env.FORAOFFICE_PERF_SMOKE === '1' ? 1 : 5
  const edits = [
    'paragraph-start',
    'paragraph-middle',
    'paragraph-end',
    'table',
    'enter',
    'delete',
    'composition',
  ] as const
  const requirements: Record<string, number> = {
    'process-start-to-visible-observation': 5,
    'process-start-to-layout-verified-observation': 5,
    'process-start-to-first-diagnostic-idle-observation': 5,
    'fresh-process-primed-sample-open-to-visible-observation': 5,
    'fresh-process-primed-sample-open-to-layout-verified-observation': 5,
    'fresh-process-primed-sample-open-to-first-diagnostic-idle-observation': 5,
    'hot-open-to-layout-verified-observation': 10,
    'hot-open-to-first-diagnostic-idle-observation': 10,
    'wheel-visible-observation': 30,
    ...Object.fromEntries(
      edits.flatMap((name) => [
        [`${name}-visible-observation`, 30],
        [`${name}-layout-verified-observation`, 30],
        [`${name}-first-diagnostic-idle-observation`, 30],
      ]),
    ),
  }
  const runs: Record<string, PerformanceObservation[]> = Object.fromEntries(
    Object.keys(requirements).map((name) => [name, []]),
  )
  const details: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const blockingTasks: number[] = []
  const pendingScreenshots: Array<{ path: string; image: Buffer }> = []
  const push = (name: string, value: number) =>
    (runs[name] ??= []).push({ ok: true, durationMs: value })
  const electronApp = resolve(
    process.env.FORAOFFICE_PERF_ELECTRON_APP ?? join(repository, 'apps/docs'),
  )
  const productDigests = {
    sdk: await treeDigest(sdk),
    executable: host === 'qt' ? sha(await readFile(process.env.FORAOFFICE_QT_HOST!)) : null,
    electronMain: host === 'electron' ? await treeDigest(join(electronApp, 'out/main')) : null,
    electronRenderer:
      host === 'electron' ? await treeDigest(join(electronApp, 'out/renderer')) : null,
  }
  const metadata = {
    schema: 1,
    host,
    label,
    headless: host === 'browser',
    harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    harnessDirty: !!execFileSync('git', ['status', '--porcelain'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    productBuild: build,
    productDigests,
    fixture: {
      sha256: sha(bytes),
      bytes: bytes.length,
      tailSha256: sha(tail),
      private: !!process.env.FORAOFFICE_PERF_DOCX,
      archivalTextRuns: oracle.textRuns.length,
      orderedMainStoryRuns: mainStory.textRuns.length,
      sections: JSON.parse(oracle.sections),
    },
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalProcessors: cpus().length,
      memoryBytes: totalmem(),
    },
    cachePolicy:
      'fresh application profile per process; OS cache uncontrolled; hot opens reuse one process',
    timingBoundary:
      'fresh process loads a tiny primer, then verified foreground before measured sample open; process-start metrics include primer/activation; separate sample-open metrics; visible source-prefix predicate polls50ms then JPEG; observation upper bounds, not INP or complete cold-start latency',
    focusPolicy:
      'Qt/Electron owned native HWND/start identity and foreground/focus verified before/after; transient DOM blur/visibility loss invalidates interval; headless browser native foreground not applicable; activation/native inspection excluded from sample-input timing',
    diagnostics:
      'internal pagination activity v1 and lazy source-story/cell diagnostics v1; same product instrumentation required on both sides',
    sourceStoryMethod:
      'independent WML main flow; unresolved AlternateContent main projections must agree; post-timing source-bound textbox text/geometry; all archival alternatives preserved separately; no complete Requires-profile conformance claim',
    compositionMethod:
      'CDP Input.imeSetComposition followed by Input.insertText; composition events recorded; not an OS IME benchmark',
    printConditions:
      'File → PDF; entire document; default original paper/section geometry; visible UI total must equal output page count; all original body text plus intended edit must occur in order',
  }
  let condition: Record<string, unknown> | undefined
  let platformFonts: Awaited<ReturnType<typeof collectPlatformFonts>> | undefined
  let correctness: Record<string, unknown> | undefined
  let currentScenario = 'process-start-to-layout-verified-observation'
  let session: PerformanceSession | undefined
  let focus: ReturnType<typeof createPerformanceFocusGuard> | undefined
  let document = ''
  try {
    for (let launch = 0; launch < launches; launch++) {
      const workspace = join(root, `launch-${launch}`)
      await mkdir(workspace)
      document = join(workspace, 'Benchmark.docx')
      await writeFile(document, bytes)
      const initialDocument = join(workspace, 'Primer.docx')
      await writeFile(initialDocument, primer)
      const started = now()
      session = await launchPerformanceHost({
        kind: host,
        workspace,
        document,
        initialDocument,
        sdk,
        electronApp,
        qtExecutable: resolve(process.env.FORAOFFICE_QT_HOST ?? join(root, 'missing-qt-host.exe')),
      })
      session.page.on('pageerror', (error) => errors.push(error.message))
      errors.push(...(await session.page.pageErrors()).map((error) => error.message))
      await installProbe(session.page)
      focus = createPerformanceFocusGuard(host, session.page, session.nativeProcessId)
      details.push({ launch, operation: 'foreground-control', observations: focus.observations })
      await focus.begin()
      const prepared = await waitForLayout(session.page, primerText, 180_000, -1, started, [
        primerText.replace(/\s+/g, ''),
      ])
      await focus.end()
      const primerGeneration = prepared.activity!.generation
      await focus.begin()
      const sampleStarted = now()
      const opened = await withDeadline(session.open(), 180_000, 'fresh-process primed sample open')
      const apiReturnMs = now() - sampleStarted
      if (opened === false) throw new Error('Fresh-process sample open returned false')
      const first = await firstVisibleContent(
        session.page,
        mainStory.paragraphs.find((p) => p.text)!.text.slice(0, 32),
        primerGeneration,
      )
      const screenshot = { path: join(workspace, 'first-visible.jpg'), image: first.image }
      pendingScreenshots.push(screenshot)
      push('process-start-to-visible-observation', now() - started)
      push('fresh-process-primed-sample-open-to-visible-observation', now() - sampleStarted)
      const firstIdleMs = await firstDiagnosticIdle(session.page, started, primerGeneration)
      push('process-start-to-first-diagnostic-idle-observation', firstIdleMs)
      push(
        'fresh-process-primed-sample-open-to-first-diagnostic-idle-observation',
        firstIdleMs - (sampleStarted - started),
      )
      const verificationStarted = now()
      const state = await waitForLayout(
        session.page,
        tail,
        180_000,
        primerGeneration,
        started,
        mainStory.textRuns,
      )
      push('process-start-to-layout-verified-observation', now() - started)
      push('fresh-process-primed-sample-open-to-layout-verified-observation', now() - sampleStarted)
      const verificationMs = now() - verificationStarted
      await focus.end()
      const stories = await verifyRenderedStories(
        session.page,
        sourceXml,
        join(workspace, 'source-stories.json'),
      )
      const writeStarted = now()
      await writeFile(screenshot.path, screenshot.image)
      pendingScreenshots.splice(pendingScreenshots.indexOf(screenshot), 1)
      details.push({
        launch,
        engine: session.evidence,
        state,
        stories,
        sampleOpenApiReturnMs: opened === null ? null : apiReturnMs,
        primerPreparationMs: sampleStarted - started,
        components: {
          firstIdleMs,
          screenshotMs: first.screenshotMs,
          verificationMs,
          fileWriteMs: now() - writeStarted,
          aggregateIncludesScreenshotAndVerification: true,
        },
      })
      if (launch === 0) platformFonts = await collectPlatformFonts(session.page)
      condition = {
        host,
        headless: metadata.headless,
        fixture: metadata.fixture,
        machine: metadata.machine,
        cachePolicy: metadata.cachePolicy,
        timingBoundary: metadata.timingBoundary,
        focusPolicy: metadata.focusPolicy,
        diagnostics: metadata.diagnostics,
        sourceStoryMethod: metadata.sourceStoryMethod,
        compositionMethod: metadata.compositionMethod,
        fonts: state.fonts,
        platformFonts,
        environment: state.environment,
        engine: session.evidence,
      }
      if (launch + 1 < launches) {
        await session.close()
        session = undefined
      }
    }
    const live = session!
    currentScenario = 'hot-open-to-layout-verified-observation'
    for (let i = 0; i < opens; i++) {
      const generation = await live.page.evaluate(
        () => (window as ProbeWindow).__docsLayoutActivity!.snapshot().generation,
      )
      await focus!.begin()
      const started = now()
      const opened = await withDeadline(live.open(), 180_000, 'document open')
      const apiReturnMs = now() - started
      if (opened === false) throw new Error('Document open returned false')
      const firstIdleMs = await firstDiagnosticIdle(live.page, started, generation)
      push('hot-open-to-first-diagnostic-idle-observation', firstIdleMs)
      const state = await waitForLayout(
        live.page,
        tail,
        180_000,
        generation,
        started,
        mainStory.textRuns,
      )
      push('hot-open-to-layout-verified-observation', now() - started)
      await focus!.end()
      const stories = await verifyRenderedStories(
        live.page,
        sourceXml,
        join(root, `hot-open-${i}-stories.json`),
      )
      details.push({
        operation: 'hot-open',
        index: i,
        apiReturnMs: opened === null ? null : apiReturnMs,
        firstIdleMs,
        state,
        stories,
      })
    }
    for (const scenario of edits) {
      for (let i = 0; i < samples; i++) {
        currentScenario = `${scenario}-layout-verified-observation`
        const fraction =
          scenario === 'paragraph-start' ? 0 : scenario === 'paragraph-end' ? 0.99 : 0.5
        const before = await chooseText(
          live.page,
          scenario === 'table' ? 'table' : 'paragraph',
          fraction,
        )
        await waitForLayout(live.page, tail)
        await focus!.begin()
        const inputIndex = await live.page.evaluate(() => {
          const probe = (window as ProbeWindow).performanceProbe!
          probe.activity = true
          probe.frames.length = 0
          probe.longTasks.length = 0
          return probe.input.length
        })
        const started = now()
        if (scenario === 'enter') await live.page.keyboard.press('Enter')
        else if (scenario === 'delete') await live.page.keyboard.press('Backspace')
        else if (scenario === 'composition') {
          const cdp = await live.page.context().newCDPSession(live.page)
          try {
            await cdp.send('Input.imeSetComposition', {
              text: '测试',
              selectionStart: 2,
              selectionEnd: 2,
            })
            await cdp.send('Input.insertText', { text: '测试' })
          } finally {
            await cdp.detach()
          }
        } else await live.page.keyboard.insertText('测')
        if (scenario === 'enter')
          await expect
            .poll(() =>
              live.page
                .locator('.ProseMirror')
                .first()
                .evaluate((pm) => pm.querySelectorAll(':scope > p').length),
            )
            .toBe(before.paragraphs + 1)
        else
          await expect
            .poll(() => live.page.locator('.ProseMirror').first().textContent())
            .not.toBe(before.text)
        const screenshotStarted = now()
        let screenshotMs = 0
        const [firstIdleMs, screenshot] = await Promise.all([
          firstDiagnosticIdle(live.page, started),
          live.page.screenshot({ type: 'jpeg', quality: 60 }).then((image) => {
            screenshotMs = now() - screenshotStarted
            push(`${scenario}-visible-observation`, now() - started)
            return image
          }),
        ])
        push(`${scenario}-first-diagnostic-idle-observation`, firstIdleMs)
        const probe = await live.page.evaluate((index) => {
          const probe = (window as ProbeWindow).performanceProbe!
          probe.activity = false
          return {
            input: probe.input.slice(index),
            frames: probe.frames.splice(0),
            longTasks: probe.longTasks.splice(0),
          }
        }, inputIndex)
        const verificationStarted = now()
        const state = await waitForLayout(live.page, tail, 180_000, -1, started)
        push(`${scenario}-layout-verified-observation`, now() - started)
        await focus!.end()
        if (!probe.input.length)
          throw new Error(`No current input/keydown attribution for ${scenario}`)
        if (scenario === 'enter' && !probe.input.some((event) => event.type === 'Enter keydown'))
          throw new Error('Enter event was not observed for the current action')
        if (
          scenario === 'composition' &&
          !probe.input.some((event) => event.type === 'insertCompositionText')
        )
          throw new Error('Current composition update was not observed')
        details.push({
          scenario,
          index: i,
          screenshotSha256: sha(screenshot),
          state,
          probe,
          components: {
            firstIdleMs,
            screenshotMs,
            verificationMs: now() - verificationStarted,
            aggregateIncludesScreenshotAndVerification: true,
          },
        })
        blockingTasks.push(...probe.longTasks.map((entry) => entry.duration))
        await live.page.keyboard.press('Control+z')
        await expect
          .poll(() => live.page.locator('.ProseMirror').first().textContent())
          .toBe(before.text)
        await expect
          .poll(() =>
            live.page
              .locator('.ProseMirror')
              .first()
              .evaluate((pm) => pm.querySelectorAll(':scope > p').length),
          )
          .toBe(before.paragraphs)
        await waitForLayout(live.page, tail)
      }
    }
    for (let i = 0; i < samples; i++) {
      currentScenario = 'wheel-visible-observation'
      const scroller = live.page.locator('.editor-scroll')
      await focus!.begin()
      await scroller.hover()
      const before = await scroller.evaluate((element) => element.scrollTop)
      const maximum = await scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      )
      await live.page.evaluate(() => {
        const probe = (window as ProbeWindow).performanceProbe!
        probe.activity = true
        probe.frames.length = 0
        probe.longTasks.length = 0
      })
      const started = now()
      await live.page.mouse.wheel(0, before + 700 >= maximum ? -600 : 600)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(before)
      await live.page.screenshot({ type: 'jpeg', quality: 60 })
      push('wheel-visible-observation', now() - started)
      await firstDiagnosticIdle(live.page, started)
      const probe = await live.page.evaluate(() => {
        const probe = (window as ProbeWindow).performanceProbe!
        probe.activity = false
        return { frames: probe.frames.splice(0), longTasks: probe.longTasks.splice(0) }
      })
      await waitForLayout(live.page, tail)
      await focus!.end()
      details.push({ scenario: 'wheel', index: i, probe })
      blockingTasks.push(...probe.longTasks.map((entry) => entry.duration))
    }
    currentScenario = 'save-print'
    const saveMarker = 'PERFORMANCE-SAVE-CHECK'
    await focus!.begin()
    const saveTarget = await chooseText(live.page, 'paragraph', 0)
    const expected = expectedInsertion(
      oracle,
      saveTarget.targetText,
      saveTarget.insertOffset,
      saveMarker,
    )
    const expectedMainStory = expectedInsertion(
      { ...oracle, ...mainStory },
      saveTarget.targetText,
      saveTarget.insertOffset,
      saveMarker,
    )
    await live.page.keyboard.insertText(saveMarker)
    await waitForLayout(live.page, tail)
    await withDeadline(live.save(), 180_000, 'document save acknowledgement')
    await expect
      .poll(
        async () => {
          const archive = await JSZip.loadAsync(await readFile(document))
          return (await archive.file('word/document.xml')!.async('string')).includes(saveMarker)
        },
        { timeout: 180_000 },
      )
      .toBe(true)
    const original = await JSZip.loadAsync(bytes)
    const saved = await JSZip.loadAsync(await readFile(document))
    const preservedParts = Object.keys(original.files).filter(
      (name) => /^word\/(media|embeddings)\//.test(name) && !original.files[name].dir,
    )
    for (const name of preservedParts) {
      const part = saved.file(name)
      if (
        !part ||
        sha(await part.async('uint8array')) !== sha(await original.files[name].async('uint8array'))
      )
        throw new Error(`Saved original resource differs: ${name}`)
    }
    const savedOracle = await documentOracle(await readFile(document))
    verifySavedContent(expected, savedOracle)
    const generation = await live.page.evaluate(
      () => (window as ProbeWindow).__docsLayoutActivity!.snapshot().generation,
    )
    if ((await withDeadline(live.open(), 180_000, 'saved document reopen')) === false)
      throw new Error('Saved document reopen returned false')
    const reopened = await waitForLayout(
      live.page,
      expected.tail,
      180_000,
      generation,
      now(),
      expectedMainStory.textRuns,
    )
    await verifyRenderedStories(
      live.page,
      await saved.file('word/document.xml')!.async('string'),
      join(root, 'reopened-source-stories.json'),
    )
    expect(await live.page.locator('.ProseMirror').first().textContent()).toContain(saveMarker)
    await focus!.end()
    const pdf = await withDeadline(live.exportPdf(), 180_000, 'PDF export')
    const printed = await waitForPdf(pdf)
    const visiblePages = Number(
      (await live.page.locator('.status-page').innerText()).match(/\d+/g)?.at(-1),
    )
    const require = createRequire(join(sdk, 'package.json'))
    const backend = require(
      join(sdk, 'services/services.cjs'),
    ) as typeof import('../apps/docs/src/services')
    const reader = await backend.createDocsResourceServices({
      stateDirectory: join(root, 'pdf-check'),
      readRoots: [dirname(pdf)],
      writeRoots: [],
    })
    try {
      await reader.setAttachments([pdf])
      let text = ''
      let total = 1
      while (text.length < total) {
        const extracted = await reader.readAttachment(pdf, text.length, 24_000)
        if (
          !extracted.ok ||
          !extracted.text ||
          typeof extracted.totalChars !== 'number' ||
          extracted.totalChars < text.length
        )
          throw new Error('PDF full-text extraction did not progress')
        total = extracted.totalChars
        text += extracted.text
      }
      verifyPrintedContent(expected, text, printed.getPageCount(), visiblePages)
    } finally {
      reader.dispose()
    }
    correctness = {
      savedEdit: true,
      reopenedEdit: true,
      originalResourcesPreserved: preservedParts.length,
      printedEdit: true,
      pdfPages: printed.getPageCount(),
      layoutPages: reopened.pages,
      visiblePages,
      pageSizesPoints: printed.getPages().map((page) => page.getSize()),
    }
    details.push({
      operation: 'save-print',
      savedSha256: sha(await readFile(document)),
      pdfSha256: sha(await readFile(pdf)),
      ...correctness,
    })
    if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`)
  } catch (error) {
    errors.push(String(error))
    if (runs[currentScenario]) runs[currentScenario].push({ ok: false, error: String(error) })
    if (session) {
      try {
        errors.push(...(await captureFailureEvidence(session.page, root, currentScenario, error)))
        if (!platformFonts) {
          try {
            const fonts = await withDeadline(
              collectPlatformFonts(session.page),
              30_000,
              'post-failure platform fonts',
            )
            await writeFile(
              join(root, 'failure-platform-fonts.json'),
              JSON.stringify(
                { phase: 'diagnostic only; complete-document gate failed', ...fonts },
                null,
                2,
              ),
            )
          } catch (fontError) {
            errors.push(`Post-failure platform-font evidence unavailable: ${String(fontError)}`)
          }
        }
      } catch (diagnostic) {
        errors.push(`Failure context unavailable: ${String(diagnostic)}`)
      }
    }
    throw error
  } finally {
    for (const screenshot of pendingScreenshots) {
      try {
        await writeFile(screenshot.path, screenshot.image)
      } catch (error) {
        errors.push(`First-visible evidence persistence failed: ${String(error)}`)
      }
    }
    try {
      await session?.close()
    } catch (error) {
      errors.push(`Cleanup failed: ${String(error)}`)
    }
    const summaries = Object.fromEntries(
      Object.entries(runs).map(([name, observations]) => [
        name,
        summarizeScenario(observations, requirements[name]),
      ]),
    )
    const report = {
      metadata,
      condition,
      correctness,
      acceptance: {
        scope:
          'automated scenario sampling only; ticket acceptance requires the reviewed three-host A/A evidence',
        nativeOsIme: 'not executed; synthetic CDP composition is diagnostic only',
        nativeOfficeComparison: 'not measured',
      },
      mainThreadBlocking: {
        scope:
          'interaction intervals including automation, screenshots and lightweight pending-work polling; full structural validation excluded; no product-only attribution',
        maxMs: blockingTasks.length ? Math.max(...blockingTasks) : 0,
        over50ms: blockingTasks.filter((value) => value > 50).length,
        nativeReference: 'not measured',
      },
      status:
        !correctness ||
        errors.length ||
        Object.values(summaries).some((summary) => summary.status !== 'complete')
          ? 'incomplete'
          : 'complete',
      summaries,
      observations: runs,
      details,
      errors,
    }
    await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2))
    if (process.env.FORAOFFICE_PERF_BEFORE) {
      const before = JSON.parse(await readFile(process.env.FORAOFFICE_PERF_BEFORE, 'utf8'))
      await writeFile(
        join(root, 'comparison.json'),
        JSON.stringify(
          {
            before: before.metadata,
            after: metadata,
            scenarios: comparePerformanceReports(before, report),
            interpretation:
              'Signed changes only; compare A/A noise and correctness before judging improvement or regression.',
          },
          null,
          2,
        ),
      )
    }
    console.log(`Docs performance evidence: ${root}`)
  }
})
