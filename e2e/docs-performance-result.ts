import { isAbsolute, relative, resolve, sep } from 'node:path'

export type PerformanceObservation = { ok: true; durationMs: number } | { ok: false; error: string }

/** Every untouched open must use the same observed conditions, including intermediate launches. */
export function retainRunCondition<T>(first: T | undefined, current: T): T {
  if (first !== undefined && JSON.stringify(first) !== JSON.stringify(current))
    throw new Error('Performance within-run conditions differ')
  return first ?? structuredClone(current)
}

export async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function summarizeScenario(observations: PerformanceObservation[], required: number) {
  if (!Number.isInteger(required) || required < 1) throw new Error('Invalid sample requirement')
  const values: number[] = []
  const errors: string[] = []
  for (const observation of observations) {
    if (!observation.ok) errors.push(observation.error)
    else if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0)
      errors.push('Invalid measured duration')
    else values.push(observation.durationMs)
  }
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return {
    status: errors.length === 0 && values.length >= required ? 'complete' : 'incomplete',
    valid: values.length,
    failed: errors.length,
    required,
    medianMs: values.length
      ? values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2
      : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    maxMs: values.at(-1) ?? null,
    errors,
  }
}

/** Real paths must be supplied by the caller after resolving existing ancestors. */
export function assertExternalArtifacts(repository: string, artifacts: string): void {
  if (!isAbsolute(artifacts)) throw new Error('Performance artifacts require an absolute path')
  const rel = relative(resolve(repository), resolve(artifacts))
  if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)))
    throw new Error('Performance artifacts must stay outside the source repository')
}

export type PerformancePdfGeometry = {
  pdfPages: number
  pageSizesPoints: Array<{ width: number; height: number }>
  printTextboxClipping: Record<string, number[]>
}

type Report = {
  status: string
  existingScenariosStatus?: string
  condition: unknown
  correctness?: PerformancePdfGeometry
  mainThreadBlocking: { scope: string; maxMs: number; over50ms: number }
  summaries: Record<string, ReturnType<typeof summarizeScenario>>
}

function hasPdfGeometry(
  value: PerformancePdfGeometry | undefined,
): value is PerformancePdfGeometry {
  if (!value || !Number.isSafeInteger(value.pdfPages) || value.pdfPages <= 0) return false
  const { pageSizesPoints, printTextboxClipping } = value
  return (
    Array.isArray(pageSizesPoints) &&
    pageSizesPoints.length === value.pdfPages &&
    pageSizesPoints.every(
      (page) =>
        Number.isFinite(page?.width) &&
        page.width > 0 &&
        Number.isFinite(page?.height) &&
        page.height > 0,
    ) &&
    !!printTextboxClipping &&
    typeof printTextboxClipping === 'object' &&
    !Array.isArray(printTextboxClipping) &&
    Object.values(printTextboxClipping).every(
      (pages) => Array.isArray(pages) && pages.every(Number.isFinite),
    )
  )
}

function hasBlockingEvidence(value: Report['mainThreadBlocking'] | undefined) {
  return (
    value &&
    typeof value.scope === 'string' &&
    value.scope.trim() &&
    Number.isFinite(value.maxMs) &&
    value.maxMs >= 0 &&
    Number.isSafeInteger(value.over50ms) &&
    value.over50ms >= 0
  )
}

/** A signed delta is evidence, never an automatic performance acceptance decision. */
export function comparePerformanceReports(before: Report, after: Report) {
  if (before.status !== 'complete' || after.status !== 'complete')
    throw new Error('Both reports must be complete')
  return compareExistingScenarios(before, after)
}

/** Preserves legacy scenario comparisons without treating incomplete acceptance as a pass. */
export function compareDiagnosticPerformanceReports(before: Report, after: Report) {
  if (
    [before, after].some(
      (report) => (report.existingScenariosStatus ?? report.status) !== 'complete',
    )
  )
    throw new Error('Both sets of existing scenarios must be complete')
  return {
    scope: 'existing-scenarios-diagnostic' as const,
    acceptance: { before: before.status, after: after.status },
    ...compareExistingScenarios(before, after),
  }
}

function compareExistingScenarios(before: Report, after: Report) {
  if (JSON.stringify(before.condition) !== JSON.stringify(after.condition))
    throw new Error('Performance conditions differ')
  const aGeometry = before.correctness
  const bGeometry = after.correctness
  if (!hasPdfGeometry(aGeometry) || !hasPdfGeometry(bGeometry))
    throw new Error('PDF page geometry evidence is missing')
  if (
    aGeometry.pdfPages !== bGeometry.pdfPages ||
    JSON.stringify(aGeometry.pageSizesPoints) !== JSON.stringify(bGeometry.pageSizesPoints)
  )
    throw new Error('PDF page count or geometry differs between reports')
  if (
    JSON.stringify(aGeometry.printTextboxClipping) !==
    JSON.stringify(bGeometry.printTextboxClipping)
  )
    throw new Error('Printed textbox clipping differs between reports')
  if (
    !hasBlockingEvidence(before.mainThreadBlocking) ||
    !hasBlockingEvidence(after.mainThreadBlocking)
  )
    throw new Error('Main-thread blocking evidence is missing or invalid')
  if (before.mainThreadBlocking.scope !== after.mainThreadBlocking.scope)
    throw new Error('Main-thread blocking scopes differ')
  const names = Object.keys(before.summaries).sort()
  if (
    !names.length ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(after.summaries).sort())
  )
    throw new Error('Performance scenarios differ or are empty')
  const scenarios = Object.fromEntries(
    names.map((name) => {
      const a = before.summaries[name]
      const b = after.summaries[name]
      if (
        a.status !== 'complete' ||
        b.status !== 'complete' ||
        a.required !== b.required ||
        a.medianMs === null ||
        b.medianMs === null ||
        a.p95Ms === null ||
        b.p95Ms === null
      )
        throw new Error(`Scenario ${name} must be complete with matching requirements`)
      return [
        name,
        {
          before: a,
          after: b,
          medianDeltaMs: b.medianMs - a.medianMs,
          p95DeltaMs: b.p95Ms - a.p95Ms,
          p95ChangePercent: a.p95Ms ? ((b.p95Ms - a.p95Ms) / a.p95Ms) * 100 : null,
        },
      ]
    }),
  )
  return {
    scenarios,
    mainThreadBlocking: { before: before.mainThreadBlocking, after: after.mainThreadBlocking },
  }
}
