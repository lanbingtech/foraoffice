// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertExternalArtifacts,
  summarizeScenario,
  comparePerformanceReports,
  compareDiagnosticPerformanceReports,
  withDeadline,
  retainRunCondition,
} from '../../../e2e/docs-performance-result'

describe('Docs performance evidence', () => {
  it('retains the first run condition and rejects an intermediate launch font/viewport drift', () => {
    const original = {
      environment: { viewport: [1280, 867], zoom: '1' },
      platformFonts: ['SimSun'],
    }
    const baseline = retainRunCondition(undefined, original)
    expect(retainRunCondition(baseline, structuredClone(original))).toEqual(original)
    expect(() => retainRunCondition(baseline, { ...original, platformFonts: ['Arial'] })).toThrow(
      'within-run conditions differ',
    )
    expect(() =>
      retainRunCondition(baseline, {
        ...original,
        environment: { viewport: [1280, 900], zoom: '1' },
      }),
    ).toThrow('within-run conditions differ')
    expect(baseline).toEqual(original)
  })
  it('fails a stalled operation at its deadline and preserves a real operation error', async () => {
    vi.useFakeTimers()
    try {
      const waiting = expect(
        withDeadline(new Promise(() => {}), 100, 'saved reopen'),
      ).rejects.toThrow('saved reopen timed out')
      await vi.advanceTimersByTimeAsync(100)
      await waiting
      await expect(
        withDeadline(Promise.reject(new Error('host failure')), 100, 'open'),
      ).rejects.toThrow('host failure')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps failures visible and refuses to treat missing or invalid observations as a passing baseline', () => {
    const result = summarizeScenario(
      [
        { ok: true, durationMs: 14 },
        { ok: false, error: 'document never completed' },
        { ok: true, durationMs: Number.NaN },
      ],
      30,
    )
    expect(result).toMatchObject({
      status: 'incomplete',
      valid: 1,
      failed: 2,
      required: 30,
      medianMs: 14,
      p95Ms: 14,
    })
    expect(result.errors).toContain('document never completed')
  })

  it('rejects empty observations and source-tree output while preserving a valid percentile', () => {
    expect(summarizeScenario([], 30)).toMatchObject({ status: 'incomplete', p95Ms: null })
    expect(
      summarizeScenario(
        Array.from({ length: 30 }, (_, i) => ({ ok: true as const, durationMs: i + 1 })),
        30,
      ),
    ).toMatchObject({ status: 'complete', medianMs: 15.5, p95Ms: 29, maxMs: 30 })
    const repository = join(tmpdir(), 'performance-source')
    expect(() => assertExternalArtifacts(repository, join(repository, 'out'))).toThrow('outside')
    expect(() => assertExternalArtifacts(repository, join(repository, '..evidence'))).toThrow(
      'outside',
    )
    expect(() =>
      assertExternalArtifacts(repository, join(tmpdir(), 'performance-output')),
    ).not.toThrow()
  })

  it('compares complete matching runs and preserves regressions instead of claiming a win', () => {
    const condition = {
      host: 'qt',
      fixture: 'same-bytes',
      fonts: ['Arial'],
      viewport: [1440, 1000],
    }
    const before = {
      status: 'complete',
      condition,
      correctness: {
        pdfPages: 1,
        pageSizesPoints: [{ width: 612, height: 792 }],
        printTextboxClipping: {},
      },
      mainThreadBlocking: { scope: 'sampled input intervals', maxMs: 51, over50ms: 1 },
      summaries: { input: summarizeScenario([{ ok: true as const, durationMs: 100 }], 1) },
    }
    const after = {
      ...before,
      mainThreadBlocking: { ...before.mainThreadBlocking, maxMs: 120, over50ms: 2 },
      summaries: { input: summarizeScenario([{ ok: true as const, durationMs: 120 }], 1) },
    }
    const comparison = comparePerformanceReports(before, after)
    expect(comparison.scenarios.input).toMatchObject({
      medianDeltaMs: 20,
      p95DeltaMs: 20,
      p95ChangePercent: 20,
    })
    expect(comparison.mainThreadBlocking).toEqual({
      before: before.mainThreadBlocking,
      after: after.mainThreadBlocking,
    })
    expect(() => comparePerformanceReports(before, { ...after, status: 'incomplete' })).toThrow(
      'complete',
    )
    const withoutViewport = { ...after, status: 'incomplete', existingScenariosStatus: 'complete' }
    expect(compareDiagnosticPerformanceReports(before, withoutViewport)).toMatchObject({
      scope: 'existing-scenarios-diagnostic',
      acceptance: { before: 'complete', after: 'incomplete' },
      scenarios: { input: { p95DeltaMs: 20 } },
    })
    expect(() => comparePerformanceReports(before, withoutViewport)).toThrow('complete')
    expect(() =>
      compareDiagnosticPerformanceReports(before, { ...after, status: 'incomplete' }),
    ).toThrow('existing scenarios must be complete')
    expect(() =>
      compareDiagnosticPerformanceReports(before, {
        ...withoutViewport,
        summaries: { input: summarizeScenario([], 1) },
      }),
    ).toThrow('Scenario input must be complete')
    expect(() =>
      comparePerformanceReports(before, { ...after, condition: { ...condition, host: 'browser' } }),
    ).toThrow('conditions')
    expect(() => comparePerformanceReports(before, { ...after, summaries: {} })).toThrow(
      'scenarios',
    )
    expect(() =>
      comparePerformanceReports(before, {
        ...after,
        correctness: { ...before.correctness, printTextboxClipping: { 'box:1:0': [2] } },
      }),
    ).toThrow('textbox clipping differs')
    expect(() =>
      comparePerformanceReports(before, {
        ...after,
        correctness: {
          ...before.correctness,
          pdfPages: 2,
          pageSizesPoints: [...before.correctness.pageSizesPoints, { width: 612, height: 792 }],
        },
      }),
    ).toThrow('PDF page count or geometry differs')
    expect(() =>
      comparePerformanceReports(before, {
        ...after,
        correctness: {
          ...before.correctness,
          pageSizesPoints: [{ width: 792, height: 612 }],
        },
      }),
    ).toThrow('PDF page count or geometry differs')
    expect(() => comparePerformanceReports(before, { ...after, correctness: undefined })).toThrow(
      'PDF page geometry evidence is missing',
    )
    const legacy = JSON.parse(JSON.stringify({ ...before, mainThreadBlocking: undefined }))
    expect(() => comparePerformanceReports(legacy, after)).toThrow(
      'Main-thread blocking evidence is missing or invalid',
    )
    const invalidBlocking = {
      ...before,
      mainThreadBlocking: { scope: '', maxMs: -1, over50ms: 0.5 },
    }
    expect(() => comparePerformanceReports(invalidBlocking, after)).toThrow(
      'Main-thread blocking evidence is missing or invalid',
    )
    const noClipping = JSON.parse(
      JSON.stringify({
        ...before,
        correctness: { ...before.correctness, printTextboxClipping: undefined },
      }),
    )
    expect(() => comparePerformanceReports(noClipping, noClipping)).toThrow(
      'PDF page geometry evidence is missing',
    )
    const badDimensions = JSON.parse(
      JSON.stringify({
        ...before,
        correctness: { ...before.correctness, pageSizesPoints: [{ width: 0, height: null }] },
      }),
    )
    expect(() => comparePerformanceReports(badDimensions, badDimensions)).toThrow(
      'PDF page geometry evidence is missing',
    )
  })
})
